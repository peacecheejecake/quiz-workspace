// Revision/publish status of the DOC-02 editor as the screen states it (one live status line).
// Publishing is index-then-switch on the server (implementation-plan §7): until the job succeeds
// the previous published revision stays active and searchable, so a failure only needs a retry.
import type { Job } from './client-api';
import type { RevisionHistoryItem, RevisionInfo } from './editor-api';

export type PublishState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'requesting' }
  | { readonly phase: 'indexing'; readonly jobId: string; readonly job: Job | null }
  | { readonly phase: 'succeeded'; readonly revisionNumber: number | null }
  | {
      readonly phase: 'failed';
      /** `indexing`: the job failed; `request`: the publish request itself did not go through. */
      readonly reason: 'indexing' | 'request';
      readonly message: string;
    };

export const PUBLISH_IDLE: PublishState = { phase: 'idle' };

export function isPublishing(state: PublishState): boolean {
  return state.phase === 'requesting' || state.phase === 'indexing';
}

const STAGE_LABELS: Readonly<Record<string, string>> = {
  loading: '준비 중',
  structuring: '구조 확인 중',
  chunking: '분할 중',
  indexing: '색인 중',
  publishing: '전환 중',
};

export interface StatusInput {
  readonly canEdit: boolean;
  /** Revision shown in the text pane (the draft for editors when there is one). */
  readonly revision: RevisionInfo | null;
  /** A draft was saved in this visit (the status says so until the next publish). */
  readonly justSaved: boolean;
  readonly publish: PublishState;
}

/** The text of the status line (role="status"); never conveys state by color alone. */
export function revisionStatusText({ canEdit, revision, justSaved, publish }: StatusInput): string {
  if (!revision) return '발행된 원문이 아직 없습니다';
  const number = `버전 ${revision.revision_number}`;
  if (!canEdit) return `발행본 · ${number} · 읽기 전용`;
  switch (publish.phase) {
    case 'requesting':
      return '발행 요청 중…';
    case 'indexing': {
      const job = publish.job;
      if (!job || job.status === 'queued') return '발행 대기 중 · 색인 작업을 기다리는 중';
      const stage = job.stage ? (STAGE_LABELS[job.stage] ?? '처리 중') : '색인 중';
      const progress = job.progress != null ? ` (${job.progress}%)` : '';
      return `발행 중 · ${stage}${progress}`;
    }
    case 'succeeded':
      return `발행 완료 · ${number}이 검색에 반영되었습니다`;
    case 'failed':
      return publish.reason === 'indexing'
        ? `색인 실패 · ${number} 초안은 그대로 남아 있습니다`
        : `발행 요청 실패 · ${number} 초안은 그대로 남아 있습니다`;
    case 'idle':
      break;
  }
  if (isDraft(revision)) {
    return justSaved
      ? `초안 저장됨 · ${number} · 발행해야 검색에 반영됩니다`
      : `초안 · ${number} · 발행해야 검색에 반영됩니다`;
  }
  return `발행됨 · ${number} · 수정하면 새 초안이 만들어집니다`;
}

/** A correction draft: a not-yet-published revision next to an active one. */
export function isDraft(revision: Pick<RevisionInfo, 'status' | 'is_active'> | null): boolean {
  return revision !== null && revision.status === 'draft' && !revision.is_active;
}

/**
 * Publish state to resume after a reload: the newest correction draft's job still running
 * (follow it) or its last attempt failed (offer retry).
 */
export function resumePublishState(
  revisions: readonly RevisionHistoryItem[],
  failureMessage: string,
): PublishState {
  const draft = revisions.find((r) => isDraft(r));
  const job = draft?.job;
  if (!draft || !job || !revisions.some((r) => r.is_active)) return PUBLISH_IDLE;
  if (job.status === 'queued' || job.status === 'running') {
    return { phase: 'indexing', jobId: job.id, job: null };
  }
  if (job.status === 'failed') {
    return { phase: 'failed', reason: 'indexing', message: failureMessage };
  }
  return PUBLISH_IDLE;
}

export const INDEX_FAILURE_MESSAGE =
  '색인에 실패해 초안을 발행하지 못했습니다. 이전 발행본이 계속 검색에 사용됩니다. 초안은 그대로 남아 있으니 다시 색인할 수 있습니다.';

/** Status line while DOC-02 shows a pinned revision (`?revision=`, opened from a search hit). */
export function pinnedStatusText(
  revision: Pick<RevisionInfo, 'revision_number' | 'is_active' | 'status'> | null,
): string {
  if (!revision) return '원문을 불러오는 중…';
  const number = `버전 ${revision.revision_number}`;
  if (revision.is_active) return `발행본 · ${number} · 검색 결과 기준 · 읽기 전용`;
  return revision.status === 'draft'
    ? `초안 · ${number} · 읽기 전용`
    : `이전 발행본 · ${number} · 검색 결과 기준 · 읽기 전용`;
}
