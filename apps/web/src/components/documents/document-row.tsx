'use client';

// One document row (DOC-01 문서 관리 and the question-PDF list, UX3c): the title (a DOC-02 link once
// ready; the file name in its tooltip) with the status badge right next to it, a meta line
// "<date time> · <size>", the live progress — upload progress with cancel, parse/index progress,
// the failure reason with retry — and a trash icon button to delete. A long-running job also shows
// how long it has waited or run, with a hint (DOC-01-AC05). State is always text, never colour
// alone (the badge text carries it).
import {
  Badge,
  Button,
  IconButton,
  ProgressBar,
  Tooltip,
  TrashIcon,
  type BadgeTone,
} from '@quiz/ui';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import type { DocumentRow } from '@/lib/documents/upload-machine';
import { formatBytes } from '@/lib/documents/validation';
import styles from './documents.module.css';
import {
  formatUpdatedAt,
  percent,
  processingElapsed,
  processingLabel,
  SLOW_PROCESSING_HINT,
  uploadPhaseLabel,
} from './labels';

export interface DocumentRowProps {
  readonly row: DocumentRow;
  readonly workspaceId: string;
  readonly canEdit: boolean;
  readonly onCancel: (localId: string) => void;
  readonly onRetry: (localId: string) => void;
  readonly onDelete: (row: DocumentRow) => void;
  /** Extra actions before the row's own (e.g. 문제 추출 in the question-PDF list). */
  readonly actions?: ReactNode;
}

export function DocumentRowItem({
  row,
  workspaceId,
  canEdit,
  onCancel,
  onRetry,
  onDelete,
  actions,
}: DocumentRowProps) {
  const { localId } = row;
  const href =
    row.documentId && row.status === 'ready'
      ? `/workspaces/${workspaceId}/documents/${row.documentId}`
      : undefined;
  const badge = statusBadge(row);
  const title = href ? (
    <Link href={href} className={styles.title}>
      {row.title}
    </Link>
  ) : (
    <span className={styles.title}>{row.title}</span>
  );
  return (
    <li className={styles.row} data-status={row.status}>
      <div className={styles.rowMain}>
        <div className={styles.titleLine}>
          <Tooltip content={row.filename}>{title}</Tooltip>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>
        <p className={styles.meta}>
          {row.updatedAt ? (
            <>
              <time dateTime={row.updatedAt}>{formatUpdatedAt(row.updatedAt)}</time>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <span>{formatBytes(row.size)}</span>
        </p>
        <RowDetail row={row} />
      </div>
      <div className={styles.actions}>
        {actions}
        {row.retryable && localId ? (
          <Button size="sm" variant="primary" onClick={() => onRetry(localId)}>
            다시 시도
          </Button>
        ) : null}
        {row.cancellable && localId ? (
          <Button size="sm" onClick={() => onCancel(localId)}>
            업로드 취소
          </Button>
        ) : null}
        {canEdit && row.documentId && !row.cancellable ? (
          <IconButton
            size="sm"
            label={`${row.title} 삭제`}
            title="삭제"
            icon={<TrashIcon />}
            onClick={() => onDelete(row)}
          />
        ) : null}
      </div>
    </li>
  );
}

/** The row's state as a badge: upload phase, processing stage, 준비 완료 or 실패. */
export function statusBadge(row: DocumentRow): { label: string; tone: BadgeTone } {
  if (row.status === 'uploading') {
    if (row.error) return { label: '업로드 중단', tone: 'warning' };
    return { label: uploadPhaseLabel(row.upload?.phase ?? 'uploading'), tone: 'accent' };
  }
  if (row.status === 'processing') return { label: processingLabel(row), tone: 'accent' };
  if (row.status === 'ready') return { label: '준비 완료', tone: 'success' };
  return { label: '실패', tone: 'danger' };
}

function RowDetail({ row }: { row: DocumentRow }) {
  if (row.status === 'uploading') {
    if (row.error) return <p className={styles.error}>{row.error}</p>;
    const upload = row.upload;
    const phase = upload?.phase ?? 'uploading';
    const value = upload ? percent(upload.loaded, upload.total) : 0;
    const sending = phase === 'uploading';
    return (
      <div className={styles.status}>
        <ProgressBar
          className={styles.progress}
          label="업로드 진행률"
          value={sending || phase === 'completing' ? value : undefined}
        />
        {sending ? <span className={styles.statusText}>{value}%</span> : null}
      </div>
    );
  }
  if (row.status === 'processing') return <ProcessingDetail row={row} />;
  if (row.status === 'failed' && row.error) return <p className={styles.error}>{row.error}</p>;
  return null;
}

function ProcessingDetail({ row }: { row: DocumentRow }) {
  const now = useNow();
  const progress = row.job?.progress ?? null;
  const elapsed = now === null ? null : processingElapsed(row, now);
  return (
    <div className={styles.status}>
      <ProgressBar
        className={styles.progress}
        label="파싱·색인 진행률"
        value={progress ?? undefined}
      />
      {progress !== null ? <span className={styles.statusText}>{progress}%</span> : null}
      {elapsed ? (
        <p className={styles.hint}>
          {elapsed} · {SLOW_PROCESSING_HINT}
        </p>
      ) : null}
    </div>
  );
}

/** The current time, ticking every second while mounted (null until the first tick, so the
 * server render and hydration never depend on the clock). */
function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
