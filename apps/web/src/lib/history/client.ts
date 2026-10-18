// Browser side of HISTORY-01: older pages of each list and the retry action, all through the
// same-origin BFF relays (src/app/api/**), which attach the session's Bearer token server-side.
// A retry calls the target's existing endpoint and creates a new job; the failed job stays.
import {
  HISTORY_PAGE_SIZE,
  type Activity,
  type HistoryPage,
  type WorkspaceAttempt,
  type WorkspaceJob,
} from './model';

export type HistoryKind = 'activities' | 'jobs' | 'attempts';

export const EDIT_CONFLICT = 'urn:quiz-workspace:problem:edit-conflict';
export const NOTHING_TO_PUBLISH = 'urn:quiz-workspace:problem:nothing-to-publish';

export class HistoryRequestError extends Error {
  constructor(
    readonly status: number | null,
    /** RFC 9457 `type` of the problem answer, when there was one. */
    readonly problemType: string | null = null,
  ) {
    super(
      status === null
        ? 'History request failed (network)'
        : `History request failed (HTTP ${status})`,
    );
    this.name = 'HistoryRequestError';
  }
}

const enc = encodeURIComponent;

export function historyListPath(workspaceId: string, kind: HistoryKind, cursor?: string): string {
  const query = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
  if (cursor) query.set('cursor', cursor);
  return `/api/workspaces/${enc(workspaceId)}/${kind}?${query.toString()}`;
}

/** The BFF endpoint that starts a retryable job again, or null when it has none. */
export function retryPath(job: Pick<WorkspaceJob, 'target_type' | 'target_id'>): string | null {
  if (!job.target_id) return null;
  if (job.target_type === 'document') return `/api/documents/${enc(job.target_id)}/publish`;
  if (job.target_type === 'question_import') {
    return `/api/question-imports/${enc(job.target_id)}/retry`;
  }
  return null;
}

type Fetch = typeof fetch;

async function request(fetchImpl: Fetch, path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', ...init.headers },
    });
  } catch {
    throw new HistoryRequestError(null);
  }
  if (!response.ok) {
    let problemType: string | null = null;
    try {
      const body: unknown = await response.json();
      const type = (body as { type?: unknown } | null)?.type;
      if (typeof type === 'string') problemType = type;
    } catch {
      // Not a problem body; the status alone describes the failure.
    }
    throw new HistoryRequestError(response.status, problemType);
  }
  try {
    return await response.json();
  } catch {
    throw new HistoryRequestError(response.status);
  }
}

interface ListBody<T> {
  readonly items: T[];
  readonly next_cursor: string | null;
}

/** Item type of each list (the BFF relays FastAPI's page unchanged). */
export interface HistoryItems {
  readonly activities: Activity;
  readonly jobs: WorkspaceJob;
  readonly attempts: WorkspaceAttempt;
}

export interface HistoryClient {
  list<K extends HistoryKind>(
    workspaceId: string,
    kind: K,
    cursor?: string,
  ): Promise<HistoryPage<HistoryItems[K]>>;
  retry(job: WorkspaceJob, idempotencyKey: string): Promise<void>;
}

export function createHistoryClient(fetchImpl: Fetch = (...a) => fetch(...a)): HistoryClient {
  return {
    async list<K extends HistoryKind>(workspaceId: string, kind: K, cursor?: string) {
      const body = (await request(fetchImpl, historyListPath(workspaceId, kind, cursor), {
        method: 'GET',
      })) as ListBody<HistoryItems[K]>;
      return { items: body.items, nextCursor: body.next_cursor };
    },
    async retry(job, idempotencyKey) {
      const path = retryPath(job);
      if (!path) throw new HistoryRequestError(409);
      const isDocument = job.target_type === 'document';
      if (isDocument && !job.target_revision_id) throw new HistoryRequestError(409, EDIT_CONFLICT);
      await request(fetchImpl, path, {
        method: 'POST',
        headers: {
          'idempotency-key': idempotencyKey,
          ...(isDocument ? { 'content-type': 'application/json' } : {}),
        },
        // Pinned to the revision the failed job indexed: if that draft was published or replaced
        // since the list was loaded, FastAPI answers 409 instead of publishing a newer draft.
        ...(isDocument ? { body: JSON.stringify({ revision_id: job.target_revision_id }) } : {}),
      });
    },
  };
}

/** Korean message for a failed retry; a stale draft (409) says why nothing was started. */
export function retryFailureMessage(error: unknown): string {
  if (
    error instanceof HistoryRequestError &&
    (error.problemType === EDIT_CONFLICT || error.problemType === NOTHING_TO_PUBLISH)
  ) {
    return '이 작업의 교정본이 그사이 게시되었거나 새 교정본으로 바뀌어 다시 시도하지 않았습니다. 목록을 새로 고쳤으니 최신 상태를 확인하세요.';
  }
  return '작업을 다시 시작하지 못했습니다. 목록을 새로 고친 뒤 다시 시도하세요.';
}
