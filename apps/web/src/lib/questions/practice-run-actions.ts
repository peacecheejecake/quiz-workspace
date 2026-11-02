'use server';

// QVIEW-01 range practice actions (BFF, implementation-plan §7): the browser never calls FastAPI
// directly. Inputs are untrusted: ids must be UUIDs, positions integers in range. FastAPI stays
// the authority — the range is resolved there (only this workspace's live CONFIRMED questions,
// the caller's study state, QVIEW-01-C01/C07), a run is the caller's only (404 for anyone else,
// C05), and no read sends an answer before that position was submitted (C03). Submitting and
// self-grading a run position use the practice panel's actions (practice-actions.ts).
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import { loginRedirectPath } from '@/lib/auth/routes';
import { redirect } from 'next/navigation';
import { isWorkspaceId } from '@/lib/workspaces/validation';
import { overviewApiQuery } from './overview-filters';
import { overviewPath, type QuestionOverview } from './overview-data';
import type { PracticeSession } from './practice-actions';
import {
  PRACTICE_RUN_MAX,
  RUN_RESULTS_PAGE,
  type PracticeRun,
  type RunItem,
  type RunRange,
  type RunResults,
} from './practice-runs';
import {
  classifyRunFailure,
  RUN_FAILURE_MESSAGES,
  type RunActionResult,
  type RunFailureKind,
} from './practice-run-problems';

function failed<T>(kind: RunFailureKind): RunActionResult<T> {
  return { ok: false, kind, message: RUN_FAILURE_MESSAGES[kind] };
}

type Api = Awaited<ReturnType<typeof createServerApiClient>>;

/** One API call; a signed-out session or a 401 sends the browser to /login (→ the home). */
async function callRunApi<T>(
  workspaceId: string,
  call: (api: Api) => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<RunActionResult<T>> {
  let outcome: RunActionResult<T> | 'unauthenticated';
  try {
    const api = await createServerApiClient();
    const { data, error, response } = await call(api);
    if (response.ok) outcome = { ok: true, data: data as T };
    else if (response.status === 401) outcome = 'unauthenticated';
    else outcome = failed(classifyRunFailure(response.status, error));
  } catch (error) {
    outcome = error instanceof NotAuthenticatedError ? 'unauthenticated' : failed('unavailable');
  }
  // redirect() throws, so it stays outside the try block.
  if (outcome === 'unauthenticated') redirect(loginRedirectPath(overviewPath(workspaceId)));
  return outcome;
}

const KEY = /^[A-Za-z0-9-]{8,128}$/;
const UUIDS_MAX = PRACTICE_RUN_MAX;

function uuidList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > UUIDS_MAX) return null;
  return value.every((v) => typeof v === 'string' && isWorkspaceId(v)) ? [...value] : null;
}

/** The range as the API takes it, or null when the untrusted input is not one. */
function validRange(range: RunRange): RunRange | null {
  if (typeof range !== 'object' || range === null) return null;
  const questionIds = uuidList(range.question_ids);
  const excluded = uuidList(range.excluded_question_ids);
  const chapters = range.chapter_ids;
  const chapterOk =
    chapters === undefined ||
    (Array.isArray(chapters) &&
      chapters.length <= UUIDS_MAX &&
      chapters.every((c) => c === 'none' || (typeof c === 'string' && isWorkspaceId(c))));
  if (!questionIds || !excluded || !chapterOk) return null;
  const out: RunRange = {
    ...(range.all === true ? { all: true } : {}),
    ...(chapters && chapters.length > 0 ? { chapter_ids: [...chapters] } : {}),
    ...(questionIds.length > 0 ? { question_ids: questionIds } : {}),
    ...(excluded.length > 0 ? { excluded_question_ids: excluded } : {}),
  };
  const filters = validFilters(range.filters);
  if (filters === null) return null;
  return filters ? { ...out, filters } : out;
}

const STATUSES: ReadonlySet<string> = new Set([
  'unseen',
  'viewed',
  'incorrect',
  'correct',
  'retry',
]);
const TYPES: ReadonlySet<string> = new Set(['MCQ', 'SHORT_ANSWER', 'ESSAY']);

function validFilters(filters: RunRange['filters']): RunRange['filters'] | null {
  if (filters === undefined) return undefined;
  if (typeof filters !== 'object' || filters === null) return null;
  const { status, favorite, retry, type } = filters;
  if (status != null && (!Array.isArray(status) || !status.every((s) => STATUSES.has(s)))) {
    return null;
  }
  if (favorite != null && typeof favorite !== 'boolean') return null;
  if (retry != null && typeof retry !== 'boolean') return null;
  if (type != null && !TYPES.has(type)) return null;
  return {
    ...(status?.length ? { status: [...new Set(status)] } : {}),
    ...(favorite != null ? { favorite } : {}),
    ...(retry != null ? { retry } : {}),
    ...(type != null ? { type } : {}),
  };
}

function own<T extends { readonly workspace_id: string }>(
  workspaceId: string,
  result: RunActionResult<T>,
): RunActionResult<T> {
  // Defensive: a run of another workspace is never shown on this home.
  if (result.ok && result.data.workspace_id !== workspaceId) return failed('notFound');
  return result;
}

type DotStatus = 'unseen' | 'viewed' | 'incorrect' | 'correct' | 'retry';

/** The range step's filters (the home's status chips, 즐겨찾기만, 다시 풀기만, 유형). */
export interface RangeQuery {
  readonly status: readonly string[];
  readonly favorite: boolean;
  readonly retry: boolean;
  readonly type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY' | null;
}

/** The questions a range can hold, under the range step's filters (the Heatmap's judgement). */
export async function listRangeQuestionsAction(
  workspaceId: string,
  filters: RangeQuery,
): Promise<RunActionResult<Pick<QuestionOverview, 'chapters' | 'items'>>> {
  if (!isWorkspaceId(workspaceId)) return failed('notFound');
  const query = overviewApiQuery({
    q: '',
    chapter: null,
    status: Array.isArray(filters?.status)
      ? filters.status.filter((s): s is DotStatus => STATUSES.has(s))
      : [],
    favorite: filters?.favorite === true ? true : null,
    retry: filters?.retry === true ? true : null,
    type: filters?.type && TYPES.has(filters.type) ? filters.type : null,
  });
  const result = await callRunApi(workspaceId, (api) =>
    api.GET('/api/v1/workspaces/{workspace_id}/questions/overview', {
      params: { path: { workspace_id: workspaceId }, query },
    }),
  );
  if (!result.ok) return result;
  // Only what the range step shows (the preview never carries an answer).
  return {
    ok: true,
    data: {
      chapters: result.data.chapters,
      items: result.data.items,
    },
  };
}

export interface RunStart {
  readonly source: 'bank';
  readonly range: RunRange;
  readonly random_order: boolean;
}

/** `시작` / `처음부터 다시`: a new run of the range (`idempotencyKey`: one run per click). */
export async function createPracticeRunAction(
  workspaceId: string,
  start: RunStart,
  idempotencyKey: string,
): Promise<RunActionResult<PracticeRun>> {
  if (!isWorkspaceId(workspaceId)) return failed('notFound');
  if (start?.source !== 'bank' || typeof start.random_order !== 'boolean') return failed('invalid');
  const range = validRange(start.range);
  if (!range) return failed('invalid');
  const key =
    typeof idempotencyKey === 'string' && KEY.test(idempotencyKey) ? idempotencyKey : null;
  return own(
    workspaceId,
    await callRunApi(workspaceId, (api) =>
      api.POST('/api/v1/workspaces/{workspace_id}/practice-runs', {
        params: {
          path: { workspace_id: workspaceId },
          ...(key ? { header: { 'Idempotency-Key': key } } : {}),
        },
        body: { source: 'bank', range, random_order: start.random_order },
      }),
    ),
  );
}

function validRun(workspaceId: string, runId: string): boolean {
  return isWorkspaceId(workspaceId) && isWorkspaceId(runId);
}

/** The run's counts and summary (no content). */
export async function getPracticeRunAction(
  workspaceId: string,
  runId: string,
): Promise<RunActionResult<PracticeRun>> {
  if (!validRun(workspaceId, runId)) return failed('notFound');
  return own(
    workspaceId,
    await callRunApi(workspaceId, (api) =>
      api.GET('/api/v1/practice-runs/{run_id}', { params: { path: { run_id: runId } } }),
    ),
  );
}

function validPosition(position: number): boolean {
  return Number.isInteger(position) && position >= 1 && position <= PRACTICE_RUN_MAX;
}

/** One position: the question without answers, or its submitted answer and result. */
export async function getRunItemAction(
  workspaceId: string,
  runId: string,
  position: number,
): Promise<RunActionResult<RunItem>> {
  if (!validRun(workspaceId, runId) || !validPosition(position)) return failed('notFound');
  return callRunApi(workspaceId, (api) =>
    api.GET('/api/v1/practice-runs/{run_id}/items/{position}', {
      params: { path: { run_id: runId, position } },
    }),
  );
}

/**
 * Opens (or resumes) the practice session of a run position: the server records the view and
 * returns the question without answers, like the practice panel's session.
 */
export async function openRunSessionAction(
  workspaceId: string,
  questionId: string,
  runId: string,
  position: number,
  idempotencyKey: string,
): Promise<RunActionResult<PracticeSession>> {
  if (!validRun(workspaceId, runId) || !isWorkspaceId(questionId) || !validPosition(position)) {
    return failed('notFound');
  }
  const key =
    typeof idempotencyKey === 'string' && KEY.test(idempotencyKey) ? idempotencyKey : null;
  return own(
    workspaceId,
    await callRunApi(workspaceId, (api) =>
      api.POST('/api/v1/questions/{question_id}/practice-sessions', {
        params: {
          path: { question_id: questionId },
          ...(key ? { header: { 'Idempotency-Key': key } } : {}),
        },
        body: { practice_run_id: runId, run_position: position },
      }),
    ),
  );
}

/** `결과 보기`: ends the run (unsubmitted positions count as skipped); idempotent. */
export async function finishPracticeRunAction(
  workspaceId: string,
  runId: string,
): Promise<RunActionResult<PracticeRun>> {
  if (!validRun(workspaceId, runId)) return failed('notFound');
  return own(
    workspaceId,
    await callRunApi(workspaceId, (api) =>
      api.POST('/api/v1/practice-runs/{run_id}/finish', { params: { path: { run_id: runId } } }),
    ),
  );
}

/** One page of the results list (no answers). */
export async function listRunResultsAction(
  workspaceId: string,
  runId: string,
  offset: number,
): Promise<RunActionResult<RunResults>> {
  if (!validRun(workspaceId, runId)) return failed('notFound');
  if (!Number.isInteger(offset) || offset < 0 || offset > PRACTICE_RUN_MAX)
    return failed('invalid');
  return callRunApi(workspaceId, (api) =>
    api.GET('/api/v1/practice-runs/{run_id}/results', {
      params: { path: { run_id: runId }, query: { offset, limit: RUN_RESULTS_PAGE } },
    }),
  );
}
