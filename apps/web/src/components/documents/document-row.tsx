'use client';

// One document row (DOC-01 문서 관리 and the question-PDF list, UX3c): the title (a DOC-02 link once
// ready; the file name in its tooltip) with the kind badge (교재 / 문제지 / 교재+문제, "분석 중"
// until classified, UX6-UPLOAD) and the status badge right next to it, a meta line
// "<date time> · <size>", the live progress — upload progress with cancel, parse/index progress,
// the failure reason with retry — `텍스트 내보내기` (DOC-03) and a trash icon button to delete. Upload and processing are one
// step progress 업로드 → 분석 → 색인 (UX6-PROGRESS) whose bar never drops back between steps. A
// long-running job also shows how long it has waited or run, with a hint (DOC-01-AC05). State is always text, never colour
// alone (the badge text carries it).
import {
  Badge,
  Button,
  IconButton,
  StepProgress,
  Tooltip,
  TrashIcon,
  type BadgeTone,
} from '@quiz/ui';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import type { DocumentKind } from '@/lib/documents/client-api';
import type { DocumentRow } from '@/lib/documents/upload-machine';
import { formatBytes } from '@/lib/documents/validation';
import { DocumentKindMenu } from './document-kind-menu';
import { TextExportMenu } from './text-export-menu';
import styles from './documents.module.css';
import {
  DOCUMENT_STEPS,
  documentProgress,
  formatUpdatedAt,
  kindBadgeLabel,
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
  /** Extra actions before the row's own (e.g. 문제 추출 / 문제 검토). */
  readonly actions?: ReactNode;
  /** `종류 변경` for editors on a ready row (문서 관리, DOC-01-AC08); absent = no menu. */
  readonly kindChange?: {
    readonly onChange: (row: DocumentRow, kind: DocumentKind) => void;
    readonly busy: boolean;
    /** Why the last change was refused (shown as an alert in the row). */
    readonly failure?: string;
  };
  /** `텍스트 내보내기` on ready rows for every member (문서 관리, DOC-03). */
  readonly textExport?: boolean;
}

export function DocumentRowItem({
  row,
  workspaceId,
  canEdit,
  onCancel,
  onRetry,
  onDelete,
  actions,
  kindChange,
  textExport = false,
}: DocumentRowProps) {
  const { localId } = row;
  const href =
    row.documentId && row.status === 'ready'
      ? `/workspaces/${workspaceId}/documents/${row.documentId}`
      : undefined;
  const badge = statusBadge(row);
  const kind = kindBadgeLabel(row);
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
          {kind ? <Badge tone="neutral">{kind}</Badge> : null}
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
        {kindChange?.failure ? (
          <p role="alert" className={styles.rowAlert}>
            {kindChange.failure}
          </p>
        ) : null}
      </div>
      <div className={styles.actions}>
        {actions}
        {kindChange && row.documentId && row.status === 'ready' ? (
          <DocumentKindMenu
            title={row.title}
            kind={row.kind}
            busy={kindChange.busy}
            onChange={(next) => kindChange.onChange(row, next)}
          />
        ) : null}
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
        {textExport && row.documentId && row.status === 'ready' ? (
          <TextExportMenu documentId={row.documentId} title={row.title} variant="row" />
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
  if (row.error && row.status !== 'processing' && row.status !== 'ready') {
    return <p className={styles.error}>{row.error}</p>;
  }
  // Uploading and processing share one element tree, so the bar glides across the steps.
  if (row.status === 'uploading' || row.status === 'processing') return <RowProgress row={row} />;
  return null;
}

function RowProgress({ row }: { row: DocumentRow }) {
  const now = useNow();
  const progress = documentProgress(row);
  const elapsed = now === null ? null : processingElapsed(row, now);
  if (!progress) return null;
  const { current, value, text, label } = progress;
  return (
    <div className={styles.status}>
      <StepProgress
        className={styles.steps}
        label={label}
        steps={DOCUMENT_STEPS}
        current={current}
        value={value}
        currentText={text}
      />
      {value !== undefined ? <span className={styles.statusText}>{value}%</span> : null}
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
