// HISTORY-01 display model (docs/screens/history-jobs.md): Korean labels for activity events,
// jobs and attempts. Pure functions shared by the server page and the client screen.
import type { Schemas } from '@quiz/api-client';

export type Activity = Schemas['Activity'];
export type WorkspaceJob = Schemas['WorkspaceJob'];
export type WorkspaceAttempt = Schemas['WorkspaceAttempt'];

export interface HistoryPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** A first page, or why it could not be read (the section shows its own failure state). */
export type HistoryLoad<T> =
  { readonly status: 'ok'; readonly page: HistoryPage<T> } | { readonly status: 'unavailable' };

export const HISTORY_PAGE_SIZE = 50;

const EVENT_LABELS: Readonly<Record<string, string>> = {
  'document.uploaded': '문서 업로드',
  'document.deleted': '문서 삭제',
  'document.block_corrected': '문서 교정',
  'document.publish_requested': '교정 게시 요청',
  'document.revision_restored': '이전 개정 복원',
  'question.created': '문제 생성',
  'question.updated': '문제 수정',
  'question.status_changed': '문제 상태 변경',
  'question.deleted': '문제 삭제',
  'question.study_state_changed': '내 학습 표시 변경',
  'question_import.started': '문제 가져오기 시작',
  'question_import.retried': '문제 가져오기 재시도',
  'question_import.published': '가져온 문제 게시',
  'workspace.created': 'Workspace 생성',
  'workspace.renamed': 'Workspace 이름 변경',
  'workspace.archived': 'Workspace 보관',
  'workspace.restored': 'Workspace 복원',
  'workspace.deleted': 'Workspace 삭제',
  'share_link.created': '공유 링크 생성',
  'share_link.updated': '공유 링크 설정 변경',
  'share_link.rotated': '공유 링크 재발급',
  'share_link.revoked': '공유 링크 철회',
};

export function eventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType;
}

const TARGET_FALLBACK: Readonly<Record<string, string>> = {
  document: '문서',
  question: '번호 없는 문제',
  question_import: '문제 가져오기',
  question_generation: '변형 문제 생성',
  workspace: 'Workspace',
  share_link: '공유 링크',
};

export function targetLabel(targetType: string | null, label: string | null): string {
  if (label) return label;
  return (targetType && TARGET_FALLBACK[targetType]) || '대상 없음';
}

/** "나" for the viewer's own entries, else the display name. */
export function actorLabel(actor: Activity['actor'], viewerId: string | null): string {
  if (!actor) return '알 수 없는 사용자';
  if (viewerId && actor.id === viewerId) return '나';
  return actor.display_name?.trim() || '이름 없는 사용자';
}

/** Document revisions are 개정 N, question revisions 버전 N; null when the event has none. */
export function revisionLabel(activity: Pick<Activity, 'target_type' | 'revision'>): string | null {
  const n = activity.revision?.number;
  if (n == null) return null;
  return activity.target_type === 'question' ? `버전 ${n}` : `개정 ${n}`;
}

const JOB_TYPE_LABELS: Readonly<Record<string, string>> = {
  'document.parse': '문서 분석·색인',
  'document.index_sync': '검색 색인 동기화',
  'question.import': '문제 가져오기',
  'question.generate': '변형 문제 생성',
};

export function jobTypeLabel(jobType: string): string {
  return JOB_TYPE_LABELS[jobType] ?? jobType;
}

const JOB_STATUS_LABELS: Readonly<Record<WorkspaceJob['status'], string>> = {
  queued: '대기 중',
  running: '진행 중',
  succeeded: '완료',
  failed: '실패',
  cancelled: '취소됨',
};

export function jobStatusLabel(status: WorkspaceJob['status']): string {
  return JOB_STATUS_LABELS[status];
}

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export function jobStatusTone(status: WorkspaceJob['status']): BadgeTone {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'cancelled') return 'warning';
  return 'accent';
}

const ERROR_LABELS: Readonly<Record<string, string>> = {
  indexing_failed: '색인 실패',
  parse_failed: '문서 분석 실패',
  cancelled: '사용자가 취소함',
  invalid_envelope: '작업 정보 오류',
  timeout: '시간 초과',
};

/** The cause of a failed or cancelled job as text (indexing → "색인 실패"); null otherwise. */
export function jobCauseLabel(job: Pick<WorkspaceJob, 'status' | 'error_code'>): string | null {
  if (job.status !== 'failed' && job.status !== 'cancelled') return null;
  const code = job.error_code;
  if (!code) return '알 수 없는 원인';
  return ERROR_LABELS[code] ?? `작업 실패 (${code})`;
}

/** Whether a finished-with-error job can be started again by this user, as text. */
export function retryabilityLabel(job: Pick<WorkspaceJob, 'status' | 'retryable'>): string | null {
  if (job.status !== 'failed' && job.status !== 'cancelled') return null;
  return job.retryable ? '재시도 가능' : '재시도 불가';
}

const RESULT_LABELS: Readonly<Record<WorkspaceAttempt['result'], string>> = {
  correct: '정답',
  incorrect: '오답',
  pending: '채점 대기',
};

export function attemptResultLabel(result: WorkspaceAttempt['result']): string {
  return RESULT_LABELS[result];
}

export function attemptResultTone(result: WorkspaceAttempt['result']): BadgeTone {
  if (result === 'correct') return 'success';
  if (result === 'incorrect') return 'danger';
  return 'warning';
}

export function questionLabel(number: number | null): string {
  return number != null ? `${number}번 문제` : '번호 없는 문제';
}

/** Fixed zone and locale so the server render and hydration agree. */
const DATE_TIME = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Seoul',
});

export function formatHistoryTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DATE_TIME.format(date);
}

/** Appends a next page, dropping ids already listed (a page boundary can move under inserts). */
export function appendPage<T extends { readonly id: string }>(
  current: HistoryPage<T>,
  next: HistoryPage<T>,
): HistoryPage<T> {
  const seen = new Set(current.items.map((item) => item.id));
  return {
    items: [...current.items, ...next.items.filter((item) => !seen.has(item.id))],
    nextCursor: next.nextCursor,
  };
}
