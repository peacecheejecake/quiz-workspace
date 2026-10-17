'use client';

// Revision status line (the screen's single role="status"), publish button, indexing failure
// alert with retry, and the revision history disclosure with rollback (restore → draft → publish).
import { Badge, Button, ConfirmDialog } from '@quiz/ui';
import { useId, useState } from 'react';
import type { RevisionHistoryItem } from '@/lib/documents/editor-api';
import { isPublishing, type PublishState } from '@/lib/documents/publish-state';
import styles from './editor.module.css';

export interface PublishBarProps {
  readonly statusText: string;
  readonly canEdit: boolean;
  readonly hasDraft: boolean;
  readonly publish: PublishState;
  readonly editing: boolean;
  readonly revisions: readonly RevisionHistoryItem[] | null;
  readonly restoring: string | null;
  readonly onPublish: () => void;
  readonly onRestore: (revision: RevisionHistoryItem) => Promise<boolean>;
  readonly onOpenHistory: () => void;
}

const DATE_FORMAT = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Seoul',
});

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : DATE_FORMAT.format(date);
}

const JOB_LABELS: Readonly<Record<string, string>> = {
  queued: '색인 대기',
  running: '색인 중',
  succeeded: '색인 완료',
  failed: '색인 실패',
  cancelled: '취소됨',
};

export function PublishBar({
  statusText,
  canEdit,
  hasDraft,
  publish,
  editing,
  revisions,
  restoring,
  onPublish,
  onRestore,
  onOpenHistory,
}: PublishBarProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<RevisionHistoryItem | null>(null);
  const historyId = useId();
  const busy = isPublishing(publish);

  return (
    <div className={styles.publishBar}>
      <div className={styles.publishRow}>
        <p role="status" className={styles.statusLine}>
          {statusText}
        </p>
        {canEdit ? (
          <div className={styles.publishActions}>
            <Button
              variant="secondary"
              size="sm"
              aria-expanded={historyOpen}
              aria-controls={historyId}
              onClick={() => {
                const next = !historyOpen;
                setHistoryOpen(next);
                if (next) onOpenHistory();
              }}
            >
              버전 기록
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onPublish}
              loading={busy}
              disabled={!hasDraft || editing}
              aria-describedby={!hasDraft ? `${historyId}-publish-hint` : undefined}
            >
              발행
            </Button>
            {!hasDraft ? (
              <span id={`${historyId}-publish-hint`} className="qz-visually-hidden">
                발행할 초안이 없습니다. 블록을 수정하면 초안이 만들어집니다.
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {canEdit && publish.phase === 'failed' ? (
        <div role="alert" className={styles.publishAlert}>
          <p>{publish.message}</p>
          <Button size="sm" onClick={onPublish} disabled={!hasDraft || editing}>
            {publish.reason === 'indexing' ? '다시 색인' : '다시 시도'}
          </Button>
        </div>
      ) : null}

      {canEdit && historyOpen ? (
        <section id={historyId} aria-label="버전 기록 목록" className={styles.history}>
          {revisions === null ? (
            <p className={styles.paneNote}>버전 기록을 불러오는 중입니다…</p>
          ) : revisions.length === 0 ? (
            <p className={styles.paneNote}>버전 기록이 없습니다.</p>
          ) : (
            <ol className={styles.historyList}>
              {revisions.map((revision) => {
                const draft = revision.status === 'draft' && !revision.is_active;
                return (
                  <li key={revision.id} className={styles.historyItem}>
                    <span className={styles.historyTitle}>버전 {revision.revision_number}</span>
                    {revision.is_active ? <Badge tone="success">현재 발행본</Badge> : null}
                    {draft ? <Badge tone="accent">초안</Badge> : null}
                    <span className={styles.historyMeta}>
                      {revision.published_at
                        ? `${formatDate(revision.published_at)} 발행`
                        : `${formatDate(revision.created_at)} 생성`}
                      {revision.job ? ` · ${JOB_LABELS[revision.job.status] ?? ''}` : ''}
                    </span>
                    {revision.status === 'published' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setPendingRestore(revision)}
                        disabled={
                          busy || editing || restoring !== null || (revision.is_active && !hasDraft)
                        }
                        loading={restoring === revision.id}
                      >
                        {revision.is_active ? '초안 되돌리기' : '이 버전으로 되돌리기'}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      ) : null}

      <ConfirmDialog
        open={pendingRestore !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRestore(null);
        }}
        title={pendingRestore?.is_active ? '초안의 수정을 버릴까요?' : '이 버전으로 되돌릴까요?'}
        description={
          pendingRestore
            ? pendingRestore.is_active
              ? '초안의 모든 수정이 현재 발행본 내용으로 돌아갑니다. 검색에는 영향이 없습니다.'
              : `버전 ${pendingRestore.revision_number}의 내용이 초안이 됩니다. 지금 초안의 수정은 사라지며, 발행해야 검색에 반영됩니다.`
            : ''
        }
        confirmLabel="되돌리기"
        loading={restoring !== null}
        onConfirm={() => {
          if (!pendingRestore) return;
          void onRestore(pendingRestore).then(() => setPendingRestore(null));
        }}
      />
    </div>
  );
}
