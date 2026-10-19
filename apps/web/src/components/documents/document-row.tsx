'use client';

// One DOC-01 list row: title (link once ready), type badge, file meta, and the live status —
// upload progress with cancel, parse/index progress, READY, or the failure reason with retry.
// A long-running job also shows how long it has waited or run, with a hint (DOC-01-AC05).
import { Badge, Button } from '@quiz/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { DocumentRow } from '@/lib/documents/upload-machine';
import { formatBytes } from '@/lib/documents/validation';
import styles from './documents.module.css';
import {
  DOCUMENT_TYPE_LABELS,
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
}

export function DocumentRowItem({
  row,
  workspaceId,
  canEdit,
  onCancel,
  onRetry,
  onDelete,
}: DocumentRowProps) {
  const { localId } = row;
  const href =
    row.documentId && row.status === 'ready'
      ? `/workspaces/${workspaceId}/documents/${row.documentId}`
      : undefined;
  return (
    <li className={styles.row} data-status={row.status}>
      <div className={styles.rowMain}>
        <div className={styles.titleLine}>
          {href ? (
            <Link href={href} className={styles.title}>
              {row.title}
            </Link>
          ) : (
            <span className={styles.title}>{row.title}</span>
          )}
          <Badge>{DOCUMENT_TYPE_LABELS[row.documentType]}</Badge>
        </div>
        <p className={styles.meta}>
          {row.filename !== row.title ? <span>{row.filename}</span> : null}
          <span>{formatBytes(row.size)}</span>
          {row.updatedAt ? (
            <span>
              수정 <time dateTime={row.updatedAt}>{formatUpdatedAt(row.updatedAt)}</time>
            </span>
          ) : null}
        </p>
        <RowStatus row={row} />
      </div>
      <div className={styles.actions}>
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
          <Button
            size="sm"
            variant="ghost"
            aria-label={`${row.title} 삭제`}
            onClick={() => onDelete(row)}
          >
            삭제
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function RowStatus({ row }: { row: DocumentRow }) {
  if (row.status === 'uploading') {
    if (row.error) {
      return (
        <div className={styles.status}>
          <Badge tone="warning">업로드 중단</Badge>
          <p className={styles.error}>{row.error}</p>
        </div>
      );
    }
    const upload = row.upload;
    const phase = upload?.phase ?? 'uploading';
    const value = upload ? percent(upload.loaded, upload.total) : 0;
    const sending = phase === 'uploading';
    return (
      <div className={styles.status}>
        <Badge tone="accent">{uploadPhaseLabel(phase)}</Badge>
        <ProgressBar
          label="업로드 진행률"
          value={sending || phase === 'completing' ? value : undefined}
        />
        {sending ? <span className={styles.statusText}>{value}%</span> : null}
      </div>
    );
  }
  if (row.status === 'processing') return <ProcessingStatus row={row} />;
  if (row.status === 'ready') {
    return (
      <div className={styles.status}>
        <Badge tone="success">준비 완료</Badge>
      </div>
    );
  }
  return (
    <div className={styles.status}>
      <Badge tone="danger">실패</Badge>
      {row.error ? <p className={styles.error}>{row.error}</p> : null}
    </div>
  );
}

function ProcessingStatus({ row }: { row: DocumentRow }) {
  const now = useNow();
  const progress = row.job?.progress ?? null;
  const elapsed = now === null ? null : processingElapsed(row, now);
  return (
    <div className={styles.status}>
      <Badge tone="accent">{processingLabel(row)}</Badge>
      <ProgressBar label="파싱·색인 진행률" value={progress ?? undefined} />
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

/** Accessible progress bar; `value` undefined = indeterminate (no aria-valuenow). */
function ProgressBar({ label, value }: { label: string; value?: number }) {
  const indeterminate = value === undefined;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : value}
      aria-valuetext={indeterminate ? '진행 중' : `${value}%`}
      className={styles.progress}
      data-indeterminate={indeterminate || undefined}
    >
      <div
        className={styles.progressFill}
        style={indeterminate ? undefined : { width: `${value}%` }}
      />
    </div>
  );
}
