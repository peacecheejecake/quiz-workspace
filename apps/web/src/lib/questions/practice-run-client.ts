// Browser side of the QVIEW-01 range run (QuestionViewer sequence, bank source). Calls go to this
// app's own `/api/...` route handlers (src/app/api, lib/documents/bff.ts), which attach the
// session's access token server-side, so browser code never holds a JWT. FastAPI stays the
// authority: it resolves the range (this workspace's live CONFIRMED questions, the caller's study
// state, QVIEW-01-C01/C07), keeps a run its creator's (C05) and sends no answer before a position
// is submitted (C03). Submitting and self-grading use the practice panel's server actions.
import type { QuestionOverview } from './overview-data';
import type { PracticeSession } from './practice-actions';
import {
  classifyRunFailure,
  RUN_FAILURE_MESSAGES,
  type RunActionResult,
  type RunFailureKind,
} from './practice-run-problems';
import {
  RUN_RESULTS_PAGE,
  type PracticeRun,
  type RunItem,
  type RunRange,
  type RunResults,
} from './practice-runs';

/** The range step's filters (the home's status chips, 즐겨찾기만, 다시 풀기만, 유형). */
export interface RangeQuery {
  readonly status: readonly string[];
  readonly favorite: boolean;
  readonly retry: boolean;
  /** Empty: every type. */
  readonly types: readonly ('MCQ' | 'SHORT_ANSWER' | 'ESSAY')[];
}

export const RUN_BFF_PATHS = {
  overview: (workspaceId: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/questions/overview`,
  create: (workspaceId: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/practice-runs`,
  run: (runId: string) => `/api/practice-runs/${encodeURIComponent(runId)}`,
  item: (runId: string, position: number) =>
    `/api/practice-runs/${encodeURIComponent(runId)}/items/${position}`,
  retrySession: (runId: string, position: number) =>
    `/api/practice-runs/${encodeURIComponent(runId)}/items/${position}/retry-session`,
  results: (runId: string, offset: number) =>
    `/api/practice-runs/${encodeURIComponent(runId)}/results?offset=${offset}&limit=${RUN_RESULTS_PAGE}`,
  finish: (runId: string) => `/api/practice-runs/${encodeURIComponent(runId)}/finish`,
  session: (questionId: string) =>
    `/api/questions/${encodeURIComponent(questionId)}/practice-sessions`,
} as const;

type FetchLike = typeof fetch;

function failed<T>(kind: RunFailureKind): RunActionResult<T> {
  return { ok: false, kind, message: RUN_FAILURE_MESSAGES[kind] };
}

export interface PracticeRunApi {
  rangeQuestions(
    query: RangeQuery,
  ): Promise<RunActionResult<Pick<QuestionOverview, 'chapters' | 'items'>>>;
  create(
    range: RunRange,
    randomOrder: boolean,
    key: string,
    count?: number | null,
    shuffleOptions?: boolean,
  ): Promise<RunActionResult<PracticeRun>>;
  getRun(runId: string): Promise<RunActionResult<PracticeRun>>;
  getItem(runId: string, position: number): Promise<RunActionResult<RunItem>>;
  openSession(
    questionId: string,
    runId: string,
    position: number,
    key: string,
    expectedResetEpoch?: number | null,
  ): Promise<RunActionResult<PracticeSession>>;
  openRetrySession(
    runId: string,
    position: number,
    key: string,
    expectedResetEpoch?: number | null,
  ): Promise<RunActionResult<PracticeSession>>;
  finish(runId: string): Promise<RunActionResult<PracticeRun>>;
  results(runId: string, offset: number): Promise<RunActionResult<RunResults>>;
}

/** The run API of `workspaceId` through the BFF (anything of another workspace is not found). */
export function createPracticeRunApi(
  workspaceId: string,
  fetchImpl: FetchLike = (...a) => fetch(...a),
): PracticeRunApi {
  async function call<T>(
    path: string,
    init: { method?: 'GET' | 'POST'; body?: unknown; key?: string } = {},
  ): Promise<RunActionResult<T>> {
    let response: Response;
    try {
      response = await fetchImpl(path, {
        method: init.method ?? 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(init.key ? { 'idempotency-key': init.key } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      return failed('unavailable');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (response.ok) return failed('unavailable');
      body = undefined;
    }
    if (!response.ok) return failed(classifyRunFailure(response.status, body));
    return { ok: true, data: body as T };
  }

  /** A run (or session) of another workspace is never shown on this home. */
  function own<T extends { readonly workspace_id: string }>(
    result: RunActionResult<T>,
  ): RunActionResult<T> {
    if (result.ok && result.data.workspace_id.toLowerCase() !== workspaceId.toLowerCase()) {
      return failed('notFound');
    }
    return result;
  }

  return {
    async rangeQuestions(query) {
      const params = new URLSearchParams();
      if (query.status.length === 0) params.set('status', 'none');
      else for (const status of query.status) params.append('status', status);
      if (query.favorite) params.set('favorite', 'true');
      if (query.retry) params.set('retry', 'true');
      for (const type of query.types) params.append('type', type);
      const search = params.toString();
      const result = await call<QuestionOverview>(
        `${RUN_BFF_PATHS.overview(workspaceId)}${search ? `?${search}` : ''}`,
      );
      return result.ok
        ? { ok: true, data: { chapters: result.data.chapters, items: result.data.items } }
        : result;
    },
    create: async (range, randomOrder, key, count, shuffleOptions) =>
      own(
        await call<PracticeRun>(RUN_BFF_PATHS.create(workspaceId), {
          method: 'POST',
          body: {
            source: 'bank',
            range,
            random_order: randomOrder,
            question_count: count ?? null,
            ...(shuffleOptions ? { shuffle_options: true } : {}),
          },
          key,
        }),
      ),
    getRun: async (runId) => own(await call<PracticeRun>(RUN_BFF_PATHS.run(runId))),
    getItem: (runId, position) => call<RunItem>(RUN_BFF_PATHS.item(runId, position)),
    openSession: async (questionId, runId, position, key, expectedResetEpoch) =>
      own(
        await call<PracticeSession>(RUN_BFF_PATHS.session(questionId), {
          method: 'POST',
          body: {
            practice_run_id: runId,
            run_position: position,
            ...(expectedResetEpoch == null ? {} : { expected_reset_epoch: expectedResetEpoch }),
          },
          key,
        }),
      ),
    openRetrySession: async (runId, position, key, epoch) =>
      own(
        await call<PracticeSession>(RUN_BFF_PATHS.retrySession(runId, position), {
          method: 'POST',
          body: epoch == null ? {} : { expected_reset_epoch: epoch },
          key,
        }),
      ),
    finish: async (runId) =>
      own(await call<PracticeRun>(RUN_BFF_PATHS.finish(runId), { method: 'POST' })),
    results: (runId, offset) => call<RunResults>(RUN_BFF_PATHS.results(runId, offset)),
  };
}
