// Browser side of the QGEN-01 data flow (M6.2 API). Calls go to this app's own `/api/...` route
// handlers, which attach the session's access token server-side, so browser code never holds a
// JWT. FastAPI stays the authority on every decision (role, archived workspace, CONFIRMED source,
// approval of a draft with an error validation, publish of exactly the approved versions).
import type { Problem, Schemas } from '@quiz/api-client';
import type { DraftUpdateBody, ImportDraft, ReviewedDraftRef } from './drafts';

export type GenerationRun = Schemas['GenerationRun'];
export type GenerationCreate = Schemas['GenerationCreate'];
export type VariationType = GenerationCreate['variation_types'][number];
export type LlmVariationType = Exclude<VariationType, 'OPTION_SHUFFLE'>;
export type GenerationDifficulty = NonNullable<GenerationCreate['difficulty']>;
export type GenerationBatch = Schemas['GenerationBatch'];
export type GenerationBatchItem = Schemas['GenerationBatchItem'];
export type GenerationBatchCreate = Schemas['GenerationBatchCreate'];
export type RandomSelection = Schemas['RandomSources'];

export const GENERATION_PROBLEMS = {
  workspaceArchived: 'urn:quiz-workspace:problem:workspace-archived',
  questionNotConfirmed: 'urn:quiz-workspace:problem:question-not-confirmed',
  idempotencyKeyReused: 'urn:quiz-workspace:problem:idempotency-key-reused',
  staleDraft: 'urn:quiz-workspace:problem:stale-draft',
  draftPublished: 'urn:quiz-workspace:problem:draft-published',
  draftNotApproved: 'urn:quiz-workspace:problem:draft-not-approved',
  duplicateQuestion: 'urn:quiz-workspace:problem:duplicate-question',
  generationBusy: 'urn:quiz-workspace:problem:generation-busy',
  noMatchingQuestions: 'urn:quiz-workspace:problem:no-matching-questions',
} as const;

export type GenerationFailureKind =
  | 'network'
  | 'unauthenticated'
  | 'archived'
  | 'forbidden'
  | 'notFound'
  | 'notConfirmed'
  | 'staleDraft'
  | 'draftPublished'
  | 'draftNotApproved'
  | 'duplicateQuestion'
  | 'idempotencyKeyReused'
  | 'generationBusy'
  | 'noMatchingQuestions'
  | 'rateLimited'
  | 'invalid'
  | 'unavailable';

export const GENERATION_FAILURE_MESSAGES: Readonly<Record<GenerationFailureKind, string>> = {
  network: '네트워크 연결이 끊겨 요청 결과를 확인하지 못했습니다. 다시 시도해 주세요.',
  unauthenticated: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
  archived: '보관된 Workspace에서는 변형 문제를 만들거나 등록할 수 없습니다.',
  forbidden: '이 Workspace에서 변형 문제를 만들거나 등록할 권한이 없습니다.',
  notFound: '원본 문제나 생성 작업을 찾을 수 없습니다. 삭제되었거나 접근 권한이 없습니다.',
  notConfirmed:
    '확정된 문제만 변형할 수 있습니다. 문제은행에서 문제를 확정한 뒤 다시 시도해 주세요.',
  staleDraft:
    '다른 곳에서 초안이 먼저 바뀌었습니다. 최신 초안을 불러왔으니 내용을 확인한 뒤 다시 승인해 주세요.',
  draftPublished: '이미 문제은행에 등록된 초안입니다. 문제은행에서 수정해 주세요.',
  draftNotApproved: '승인되지 않은 초안이 있어 등록하지 못했습니다. 승인 상태를 확인해 주세요.',
  duplicateQuestion:
    '문제은행에 이미 같은 문제가 있거나 같은 내용의 초안을 함께 등록하려 해서 등록하지 못했습니다. 초안을 새로 불러왔으니 "이미 같은 문제가 있습니다" 표시를 확인해 주세요.',
  idempotencyKeyReused: '요청이 겹쳐 처리하지 못했습니다. 다시 시도해 주세요.',
  generationBusy:
    '이 Workspace에서 진행 중인 변형 생성이 많습니다. 진행 중인 생성이 끝난 뒤 다시 시도해 주세요.',
  noMatchingQuestions: '조건에 맞는 확정 문제가 없습니다. 필터를 바꿔 다시 시도해 주세요.',
  rateLimited: '변형 생성을 너무 자주 시작했습니다. 잠시 후 다시 시도해 주세요.',
  invalid:
    '요청을 처리할 수 없습니다. 변형 유형과 원본 문제의 출처를 확인하고, 초안은 검증 항목을 고친 뒤 승인해 주세요.',
  unavailable: '일시적인 오류로 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

export class GenerationApiError extends Error {
  constructor(
    readonly kind: GenerationFailureKind,
    readonly status = 0,
  ) {
    super(GENERATION_FAILURE_MESSAGES[kind]);
    this.name = 'GenerationApiError';
  }
}

export function classifyGenerationFailure(status: number, body: unknown): GenerationFailureKind {
  const type =
    typeof body === 'object' && body !== null ? (body as Partial<Problem>).type : undefined;
  if (status === 401) return 'unauthenticated';
  if (status === 403) {
    return type === GENERATION_PROBLEMS.workspaceArchived ? 'archived' : 'forbidden';
  }
  if (status === 404) return 'notFound';
  if (status === 409) {
    switch (type) {
      case GENERATION_PROBLEMS.questionNotConfirmed:
        return 'notConfirmed';
      case GENERATION_PROBLEMS.staleDraft:
        return 'staleDraft';
      case GENERATION_PROBLEMS.draftPublished:
        return 'draftPublished';
      case GENERATION_PROBLEMS.draftNotApproved:
        return 'draftNotApproved';
      case GENERATION_PROBLEMS.duplicateQuestion:
        return 'duplicateQuestion';
      case GENERATION_PROBLEMS.idempotencyKeyReused:
        return 'idempotencyKeyReused';
      case GENERATION_PROBLEMS.generationBusy:
        return 'generationBusy';
      case GENERATION_PROBLEMS.noMatchingQuestions:
        return 'noMatchingQuestions';
      default:
        return 'unavailable';
    }
  }
  if (status === 422) return 'invalid';
  if (status === 429) return 'rateLimited';
  return 'unavailable';
}

/** Why a run failed, by its stable `error_code` (the API's English never reaches the UI). */
const RUN_FAILURES: Readonly<Record<string, string>> = {
  llm_output_invalid: '생성 모델의 응답 형식이 올바르지 않았습니다.',
  no_valid_candidates: '검증을 통과한 변형 후보가 없었습니다.',
  llm_unavailable: '생성 모델에 연결하지 못했습니다.',
  llm_not_configured: '생성 모델이 설정되어 있지 않습니다. 관리자에게 문의해 주세요.',
  source_question_deleted: '원본 문제가 삭제되었습니다.',
  source_passages_missing:
    '근거로 쓸 원문을 찾지 못했습니다. 원본 문제에 출처 쪽을 연결하거나 관련 문서를 올려 처리한 뒤 다시 시도해 주세요.',
  search_unavailable: '관련 원문을 검색하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  workspace_unavailable: 'Workspace가 보관되었거나 접근할 수 없습니다.',
  cancelled: '작업이 취소되었습니다.',
};

export function runFailureMessage(errorCode: string | null | undefined): string {
  const reason = (errorCode && RUN_FAILURES[errorCode]) || '알 수 없는 오류가 발생했습니다.';
  return `변형 문제를 만들지 못했습니다. ${reason}${errorCode ? ` (${errorCode})` : ''}`;
}

export function isRunWorking(run: Pick<GenerationRun, 'status'>): boolean {
  return run.status === 'queued' || run.status === 'running';
}

const enc = encodeURIComponent;

export function generatePath(
  workspaceId: string,
  sourceQuestionId?: string | null,
  runId?: string | null,
  batchId?: string | null,
): string {
  const base = `/workspaces/${workspaceId}/questions/generate`;
  if (!sourceQuestionId) return base;
  return `${base}?source=${enc(sourceQuestionId)}${runId ? `&run=${enc(runId)}` : ''}${
    batchId ? `&batch=${enc(batchId)}` : ''
  }`;
}

/** The batch results page (QGEN-MULTI): one group per source of the batch. */
export function batchPath(workspaceId: string, batchId: string): string {
  return `/workspaces/${workspaceId}/questions/generate?batch=${enc(batchId)}`;
}

export const GENERATION_BFF_PATHS = {
  start: (questionId: string) => `/api/questions/${enc(questionId)}/generations`,
  runs: (workspaceId: string, sourceQuestionId: string, limit: number) =>
    `/api/workspaces/${enc(workspaceId)}/question-generations?source_question_id=${enc(sourceQuestionId)}&limit=${limit}`,
  run: (runId: string) => `/api/question-generations/${enc(runId)}`,
  drafts: (runId: string) => `/api/question-generations/${enc(runId)}/drafts`,
  publish: (runId: string) => `/api/question-generations/${enc(runId)}/publish`,
  draft: (draftId: string) => `/api/question-drafts/${enc(draftId)}`,
  batches: (workspaceId: string) =>
    `/api/workspaces/${enc(workspaceId)}/question-generation-batches`,
  batch: (workspaceId: string, batchId: string) =>
    `/api/workspaces/${enc(workspaceId)}/question-generation-batches/${enc(batchId)}`,
} as const;

export interface GenerationClient {
  startGeneration(
    questionId: string,
    body: GenerationCreate,
    idempotencyKey: string,
  ): Promise<GenerationRun>;
  /** The newest `limit` runs of `sourceQuestionId` (newest first). */
  listRuns(
    workspaceId: string,
    sourceQuestionId: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<GenerationRun[]>;
  getRun(runId: string, signal?: AbortSignal): Promise<GenerationRun>;
  listDrafts(runId: string, signal?: AbortSignal): Promise<ImportDraft[]>;
  updateDraft(draftId: string, body: DraftUpdateBody): Promise<ImportDraft>;
  publish(
    runId: string,
    drafts: readonly ReviewedDraftRef[],
  ): Promise<{ draft_id: string; question_id: string }[]>;
  startBatch(
    workspaceId: string,
    body: GenerationBatchCreate,
    idempotencyKey: string,
  ): Promise<GenerationBatch>;
  getBatch(workspaceId: string, batchId: string, signal?: AbortSignal): Promise<GenerationBatch>;
}

type FetchLike = typeof fetch;

export function createGenerationClient(
  fetchImpl: FetchLike = (...a) => fetch(...a),
): GenerationClient {
  async function call<T>(
    path: string,
    init: RequestInit & { idempotencyKey?: string } = {},
  ): Promise<T> {
    const { idempotencyKey, ...rest } = init;
    let response: Response;
    try {
      response = await fetchImpl(path, {
        ...rest,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          ...(rest.body ? { 'content-type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
      });
    } catch (error) {
      if (rest.signal?.aborted) throw error;
      throw new GenerationApiError('network');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (response.ok) throw new GenerationApiError('network', response.status);
      body = undefined;
    }
    if (!response.ok) {
      throw new GenerationApiError(
        classifyGenerationFailure(response.status, body),
        response.status,
      );
    }
    return body as T;
  }

  return {
    startGeneration: (questionId, body, idempotencyKey) =>
      call(GENERATION_BFF_PATHS.start(questionId), {
        method: 'POST',
        body: JSON.stringify(body),
        idempotencyKey,
      }),
    listRuns: async (workspaceId, sourceQuestionId, limit, signal) =>
      (
        await call<{ items: GenerationRun[] }>(
          GENERATION_BFF_PATHS.runs(workspaceId, sourceQuestionId, limit),
          { signal },
        )
      ).items,
    getRun: (runId, signal) => call(GENERATION_BFF_PATHS.run(runId), { signal }),
    listDrafts: async (runId, signal) =>
      (await call<{ items: ImportDraft[] }>(GENERATION_BFF_PATHS.drafts(runId), { signal })).items,
    updateDraft: (draftId, body) =>
      call(GENERATION_BFF_PATHS.draft(draftId), { method: 'PATCH', body: JSON.stringify(body) }),
    publish: async (runId, drafts) =>
      (
        await call<{ items: { draft_id: string; question_id: string }[] }>(
          GENERATION_BFF_PATHS.publish(runId),
          { method: 'POST', body: JSON.stringify({ drafts }) },
        )
      ).items,
    startBatch: (workspaceId, body, idempotencyKey) =>
      call(GENERATION_BFF_PATHS.batches(workspaceId), {
        method: 'POST',
        body: JSON.stringify(body),
        idempotencyKey,
      }),
    getBatch: (workspaceId, batchId, signal) =>
      call(GENERATION_BFF_PATHS.batch(workspaceId, batchId), { signal }),
  };
}
