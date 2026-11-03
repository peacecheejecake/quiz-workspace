// Browser side of HILITE-01: the reader's own highlights through this app's `/api/...` relay
// routes (the session's access token is added server-side). FastAPI reads and writes only the
// signed-in user's rows; archived workspaces still accept highlight writes (user decision
// 2026-11-02 (i)).
import type { HighlightColor } from '@quiz/ui';
import type { MyHighlight } from '@/lib/notes/model';

export type HighlightFailureKind =
  | 'gone'
  | 'changed'
  | 'overlap'
  | 'notRestorable'
  | 'limit'
  | 'unavailable'
  | 'stale'
  | 'unauthenticated'
  | 'failed';

export const HIGHLIGHT_PROBLEMS = {
  targetUnavailable: 'urn:quiz-workspace:problem:highlight-target-unavailable',
  limit: 'urn:quiz-workspace:problem:highlight-limit',
  changed: 'urn:quiz-workspace:problem:highlight-changed',
  notRestorable: 'urn:quiz-workspace:problem:highlight-not-restorable',
  overlap: 'urn:quiz-workspace:problem:highlight-overlap',
  staleRevision: 'urn:quiz-workspace:problem:stale-revision',
} as const;

export const HIGHLIGHT_FAILURE_MESSAGES: Readonly<Record<HighlightFailureKind, string>> = {
  gone: '이미 지운 하이라이트입니다.',
  changed: '하이라이트가 다른 곳에서 바뀌었습니다. 다시 불러왔습니다.',
  overlap: '같은 자리에 다른 하이라이트가 있어 되돌리지 못했습니다',
  notRestorable: '되돌릴 수 있는 시간이 지났습니다.',
  limit: '이곳에는 하이라이트를 더 만들 수 없습니다(최대 500개).',
  unavailable: '이 글에는 하이라이트를 만들 수 없습니다.',
  stale: '문제가 바뀌었습니다. 다시 불러온 뒤 골라 주세요.',
  unauthenticated: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
  failed: '하이라이트를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

export class HighlightApiError extends Error {
  constructor(
    readonly kind: HighlightFailureKind,
    readonly status = 0,
  ) {
    super(`Highlight request failed: ${kind}`);
    this.name = 'HighlightApiError';
  }
}

export function classifyHighlightFailure(status: number, body: unknown): HighlightFailureKind {
  const type =
    typeof body === 'object' && body !== null ? (body as { type?: unknown }).type : undefined;
  if (type === HIGHLIGHT_PROBLEMS.changed) return 'changed';
  if (type === HIGHLIGHT_PROBLEMS.overlap) return 'overlap';
  if (type === HIGHLIGHT_PROBLEMS.notRestorable) return 'notRestorable';
  if (type === HIGHLIGHT_PROBLEMS.limit) return 'limit';
  if (type === HIGHLIGHT_PROBLEMS.targetUnavailable) return 'unavailable';
  if (type === HIGHLIGHT_PROBLEMS.staleRevision) return 'stale';
  if (status === 401) return 'unauthenticated';
  if (status === 404) return 'gone';
  return 'failed';
}

type FetchLike = typeof fetch;
const defaultFetch: FetchLike = (...a) => fetch(...a);

async function call<T>(fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new HighlightApiError('failed');
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw new HighlightApiError(classifyHighlightFailure(response.status, body), response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function list(fetchImpl: FetchLike, url: string, signal?: AbortSignal) {
  const body = await call<{ items: MyHighlight[] }>(fetchImpl, url, { signal });
  return body.items;
}

/** The reader's highlights of one question's explanation (only once it is on screen). */
export function getQuestionHighlights(
  questionId: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = defaultFetch,
): Promise<readonly MyHighlight[]> {
  return list(fetchImpl, `/api/questions/${encodeURIComponent(questionId)}/my-highlights`, signal);
}

/** The reader's explanation highlights of the "챕터 없음" group. */
export function getChapterlessHighlights(
  workspaceId: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = defaultFetch,
): Promise<readonly MyHighlight[]> {
  return list(
    fetchImpl,
    `/api/workspaces/${encodeURIComponent(workspaceId)}/my-highlights?chapter=none`,
    signal,
  );
}

export type HighlightTargetInput =
  | { readonly kind: 'note'; readonly chapter_note_id: string }
  | {
      readonly kind: 'explanation';
      readonly question_id: string;
      readonly question_revision_id?: string;
    };

export interface HighlightCreateInput {
  readonly target: HighlightTargetInput;
  readonly anchor: { readonly block: string; readonly start: number; readonly end: number };
  readonly color: HighlightColor;
  readonly replace_ids?: readonly string[];
}

export function createHighlight(
  input: HighlightCreateInput,
  idempotencyKey: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MyHighlight> {
  return call(fetchImpl, '/api/my-highlights', {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify(input),
  });
}

export function recolorHighlight(
  id: string,
  color: HighlightColor,
  version: number,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MyHighlight> {
  return call(fetchImpl, `/api/my-highlights/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ color, version }),
  });
}

export function deleteHighlight(id: string, fetchImpl: FetchLike = defaultFetch): Promise<void> {
  return call(fetchImpl, `/api/my-highlights/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function restoreHighlight(
  id: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MyHighlight> {
  return call(fetchImpl, `/api/my-highlights/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
  });
}
