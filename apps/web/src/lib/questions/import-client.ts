// Browser side of the QIMPORT-01 data flow. Calls go to this app's own `/api/...` route handlers
// (src/app/api, `lib/documents/bff.ts`), which attach the session's access token server-side, so
// browser code never holds a JWT. FastAPI stays the authority on every decision.
import type { Problem } from '@quiz/api-client';
import type { DraftUpdateBody, ImportDraft, ImportRun, ReviewedDraftRef } from './drafts';

export const IMPORT_PROBLEMS = {
  workspaceArchived: 'urn:quiz-workspace:problem:workspace-archived',
  idempotencyKeyReused: 'urn:quiz-workspace:problem:idempotency-key-reused',
  documentNotReady: 'urn:quiz-workspace:problem:document-not-ready',
  importNotRetryable: 'urn:quiz-workspace:problem:import-not-retryable',
  staleDraft: 'urn:quiz-workspace:problem:stale-draft',
  draftPublished: 'urn:quiz-workspace:problem:draft-published',
  draftNotApproved: 'urn:quiz-workspace:problem:draft-not-approved',
} as const;

export type ImportFailureKind =
  | 'network'
  | 'unauthenticated'
  | 'archived'
  | 'forbidden'
  | 'notFound'
  | 'documentNotReady'
  | 'notRetryable'
  | 'staleDraft'
  | 'draftPublished'
  | 'draftNotApproved'
  | 'idempotencyKeyReused'
  | 'invalid'
  | 'unavailable';

export const IMPORT_FAILURE_MESSAGES: Readonly<Record<ImportFailureKind, string>> = {
  network: '네트워크 연결이 끊겨 요청 결과를 확인하지 못했습니다. 다시 시도해 주세요.',
  unauthenticated: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
  archived: '보관된 Workspace에서는 문제를 가져오거나 등록할 수 없습니다.',
  forbidden: '이 Workspace에서 문제를 가져오거나 등록할 권한이 없습니다.',
  notFound: '가져오기 작업이나 초안을 찾을 수 없습니다. 삭제되었거나 접근 권한이 없습니다.',
  documentNotReady: 'PDF 처리가 아직 끝나지 않았습니다. 잠시 후 다시 시도해 주세요.',
  notRetryable: '이 가져오기 작업은 다시 시도할 수 없는 상태입니다. 목록을 새로 불러왔습니다.',
  staleDraft:
    '다른 곳에서 초안이 먼저 바뀌었습니다. 최신 초안을 불러왔으니 내용을 확인한 뒤 다시 승인해 주세요.',
  draftPublished: '이미 문제은행에 등록된 초안입니다. 문제은행에서 수정해 주세요.',
  draftNotApproved: '승인되지 않은 초안이 있어 등록하지 못했습니다. 승인 상태를 확인해 주세요.',
  idempotencyKeyReused: '요청이 겹쳐 처리하지 못했습니다. 다시 시도해 주세요.',
  invalid: '초안 내용을 확인해 주세요. 승인하려면 정답과 보기가 올바르게 입력되어야 합니다.',
  unavailable: '일시적인 오류로 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

export class ImportApiError extends Error {
  constructor(
    readonly kind: ImportFailureKind,
    readonly status = 0,
  ) {
    super(IMPORT_FAILURE_MESSAGES[kind]);
    this.name = 'ImportApiError';
  }
}

export function classifyImportFailure(status: number, body: unknown): ImportFailureKind {
  const type =
    typeof body === 'object' && body !== null ? (body as Partial<Problem>).type : undefined;
  if (status === 401) return 'unauthenticated';
  if (status === 403) return type === IMPORT_PROBLEMS.workspaceArchived ? 'archived' : 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 409) {
    switch (type) {
      case IMPORT_PROBLEMS.documentNotReady:
        return 'documentNotReady';
      case IMPORT_PROBLEMS.importNotRetryable:
        return 'notRetryable';
      case IMPORT_PROBLEMS.staleDraft:
        return 'staleDraft';
      case IMPORT_PROBLEMS.draftPublished:
        return 'draftPublished';
      case IMPORT_PROBLEMS.draftNotApproved:
        return 'draftNotApproved';
      case IMPORT_PROBLEMS.idempotencyKeyReused:
        return 'idempotencyKeyReused';
      default:
        return 'unavailable';
    }
  }
  if (status === 422) return 'invalid';
  return 'unavailable';
}

const enc = encodeURIComponent;

export function importPath(workspaceId: string): string {
  return `/workspaces/${workspaceId}/questions/import`;
}

export const IMPORT_BFF_PATHS = {
  imports: (workspaceId: string) => `/api/workspaces/${enc(workspaceId)}/question-imports`,
  run: (importId: string) => `/api/question-imports/${enc(importId)}`,
  drafts: (importId: string) => `/api/question-imports/${enc(importId)}/drafts`,
  publish: (importId: string) => `/api/question-imports/${enc(importId)}/publish`,
  retry: (importId: string) => `/api/question-imports/${enc(importId)}/retry`,
  draft: (draftId: string) => `/api/question-drafts/${enc(draftId)}`,
} as const;

export interface ImportClient {
  startImport(workspaceId: string, documentId: string, idempotencyKey: string): Promise<ImportRun>;
  getRun(importId: string, signal?: AbortSignal): Promise<ImportRun>;
  listDrafts(importId: string, signal?: AbortSignal): Promise<ImportDraft[]>;
  retryImport(importId: string, idempotencyKey: string): Promise<ImportRun>;
  updateDraft(draftId: string, body: DraftUpdateBody): Promise<ImportDraft>;
  publish(
    importId: string,
    drafts: readonly ReviewedDraftRef[],
  ): Promise<{ draft_id: string; question_id: string }[]>;
}

type FetchLike = typeof fetch;

export function createImportClient(fetchImpl: FetchLike = (...a) => fetch(...a)): ImportClient {
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
      throw new ImportApiError('network');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // A response that never fully arrived is as unknown as a dropped one.
      if (response.ok) throw new ImportApiError('network', response.status);
      body = undefined;
    }
    if (!response.ok) {
      throw new ImportApiError(classifyImportFailure(response.status, body), response.status);
    }
    return body as T;
  }

  return {
    startImport: (workspaceId, documentId, idempotencyKey) =>
      call(IMPORT_BFF_PATHS.imports(workspaceId), {
        method: 'POST',
        body: JSON.stringify({ document_id: documentId }),
        idempotencyKey,
      }),
    getRun: (importId, signal) => call(IMPORT_BFF_PATHS.run(importId), { signal }),
    listDrafts: async (importId, signal) =>
      (await call<{ items: ImportDraft[] }>(IMPORT_BFF_PATHS.drafts(importId), { signal })).items,
    retryImport: (importId, idempotencyKey) =>
      call(IMPORT_BFF_PATHS.retry(importId), { method: 'POST', idempotencyKey }),
    updateDraft: (draftId, body) =>
      call(IMPORT_BFF_PATHS.draft(draftId), { method: 'PATCH', body: JSON.stringify(body) }),
    publish: async (importId, drafts) =>
      (
        await call<{ items: { draft_id: string; question_id: string }[] }>(
          IMPORT_BFF_PATHS.publish(importId),
          { method: 'POST', body: JSON.stringify({ drafts }) },
        )
      ).items,
  };
}
