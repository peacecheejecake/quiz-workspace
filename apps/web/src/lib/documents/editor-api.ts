// Browser side of the DOC-02 data flow (PDF viewer, outline, canonical text corrections, publish).
// Every call goes to this app's own `/api/documents/...` route handlers (bff.ts), which attach the
// session's access token server-side; FastAPI decides authorization, revision consistency and
// publish. Only the short-lived signed read URL of the original PDF reaches the browser.
import type { Problem, Schemas } from '@quiz/api-client';

export type DocumentDetail = Schemas['DocumentDetail'];
export type OutlineItem = Schemas['OutlineItem'];
export type Outline = Schemas['Outline'];
export type ContentBlock = Schemas['ContentBlock'];
export type BlockList = Schemas['BlockList'];
export type BlockDetail = Schemas['BlockDetail'];
export type RevisionInfo = Schemas['RevisionInfo'];
export type RevisionHistoryItem = Schemas['RevisionHistoryItem'];
export type PublishAccepted = Schemas['PublishAccepted'];
export type RestoredDraft = Schemas['RestoredDraft'];
export type SignedReadUrl = Schemas['SignedReadUrl'];

/** `active` = the published revision readers see; `latest` = the correction draft if any. */
export type RevisionSelector = 'active' | 'latest';

export const EDITOR_PROBLEMS = {
  editConflict: 'urn:quiz-workspace:problem:edit-conflict',
  publishInProgress: 'urn:quiz-workspace:problem:publish-in-progress',
  nothingToPublish: 'urn:quiz-workspace:problem:nothing-to-publish',
  documentNotReady: 'urn:quiz-workspace:problem:document-not-ready',
  workspaceArchived: 'urn:quiz-workspace:problem:workspace-archived',
  insufficientRole: 'urn:quiz-workspace:problem:insufficient-role',
} as const;

export type EditorFailureKind =
  | 'network'
  | 'unauthenticated'
  | 'archived'
  | 'forbidden'
  | 'notFound'
  | 'conflict'
  | 'publishInProgress'
  | 'nothingToPublish'
  | 'notReady'
  | 'invalid'
  | 'unavailable';

export const EDITOR_FAILURE_MESSAGES: Readonly<Record<EditorFailureKind, string>> = {
  network: '네트워크 연결이 끊겨 처리하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.',
  unauthenticated: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
  archived: '보관된 Workspace의 문서는 수정하거나 발행할 수 없습니다.',
  forbidden: '이 문서를 수정하거나 발행할 권한이 없습니다.',
  notFound: '문서나 블록을 찾을 수 없습니다. 삭제되었을 수 있습니다.',
  conflict: '다른 곳에서 이 내용이 먼저 바뀌었습니다. 최신 내용을 확인한 뒤 다시 저장해 주세요.',
  publishInProgress:
    '초안을 발행(색인)하는 중이라 지금은 수정할 수 없습니다. 끝난 뒤 다시 시도해 주세요.',
  nothingToPublish: '발행할 변경 사항이 없습니다.',
  notReady: '문서 처리가 아직 끝나지 않았습니다. 처리가 끝난 뒤 다시 시도해 주세요.',
  invalid: '입력한 내용을 저장할 수 없습니다.',
  unavailable: '일시적인 오류로 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

export class EditorApiError extends Error {
  readonly detail?: string;

  constructor(
    readonly kind: EditorFailureKind,
    readonly status = 0,
    detail?: string,
  ) {
    super(EDITOR_FAILURE_MESSAGES[kind]);
    this.name = 'EditorApiError';
    this.detail = detail;
  }

  /** Retrying the same request may succeed. */
  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'unavailable';
  }
}

function asProblem(body: unknown): Partial<Problem> | undefined {
  return typeof body === 'object' && body !== null ? (body as Partial<Problem>) : undefined;
}

export function classifyEditorFailure(status: number, body: unknown): EditorFailureKind {
  const type = asProblem(body)?.type;
  if (status === 401) return 'unauthenticated';
  if (status === 403) return type === EDITOR_PROBLEMS.workspaceArchived ? 'archived' : 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 409) {
    if (type === EDITOR_PROBLEMS.editConflict) return 'conflict';
    if (type === EDITOR_PROBLEMS.publishInProgress) return 'publishInProgress';
    if (type === EDITOR_PROBLEMS.nothingToPublish) return 'nothingToPublish';
    if (type === EDITOR_PROBLEMS.documentNotReady) return 'notReady';
    return 'conflict';
  }
  if (status === 400 || status === 413 || status === 422) return 'invalid';
  return 'unavailable';
}

export function editorErrorFromResponse(status: number, body: unknown): EditorApiError {
  const detail = asProblem(body)?.detail;
  return new EditorApiError(
    classifyEditorFailure(status, body),
    status,
    typeof detail === 'string' ? detail : undefined,
  );
}

const enc = encodeURIComponent;

export const EDITOR_PATHS = {
  document: (id: string) => `/api/documents/${enc(id)}`,
  outline: (id: string, revision: RevisionSelector) =>
    `/api/documents/${enc(id)}/outline?revision=${revision}`,
  blocks: (id: string, revision: RevisionSelector, after?: number) =>
    `/api/documents/${enc(id)}/blocks?revision=${revision}&limit=${BLOCK_PAGE_SIZE}` +
    (after !== undefined ? `&after=${after}` : ''),
  block: (id: string, blockId: string, revision?: RevisionSelector) =>
    `/api/documents/${enc(id)}/blocks/${enc(blockId)}` + (revision ? `?revision=${revision}` : ''),
  publish: (id: string) => `/api/documents/${enc(id)}/publish`,
  revisions: (id: string) => `/api/documents/${enc(id)}/revisions`,
  restore: (id: string, revisionId: string) =>
    `/api/documents/${enc(id)}/revisions/${enc(revisionId)}/restore`,
  sourceUrl: (id: string) => `/api/documents/${enc(id)}/source-url`,
} as const;

/** FastAPI's maximum page size for block lists. */
export const BLOCK_PAGE_SIZE = 500;
/** Safety stop for runaway paging (500 × 200 = 100 000 blocks). */
const MAX_BLOCK_PAGES = 200;

export interface DocumentContent {
  readonly revision: RevisionInfo | null;
  readonly outline: readonly OutlineItem[];
  readonly blocks: readonly ContentBlock[];
}

export interface EditorClient {
  getDocument(id: string, signal?: AbortSignal): Promise<DocumentDetail>;
  /** Outline + every block of one revision; retried once if the revision moved in between. */
  loadContent(
    id: string,
    revision: RevisionSelector,
    signal?: AbortSignal,
  ): Promise<DocumentContent>;
  getBlock(id: string, blockId: string, revision: RevisionSelector): Promise<BlockDetail>;
  correctBlock(
    id: string,
    blockId: string,
    text: string,
    baseVersion: string,
  ): Promise<BlockDetail>;
  publish(id: string, revisionId: string, idempotencyKey: string): Promise<PublishAccepted>;
  listRevisions(id: string, signal?: AbortSignal): Promise<RevisionHistoryItem[]>;
  restore(id: string, revisionId: string): Promise<RestoredDraft>;
  getSourceUrl(id: string, signal?: AbortSignal): Promise<SignedReadUrl>;
}

type FetchLike = typeof fetch;

export function createEditorClient(fetchImpl: FetchLike = (...a) => fetch(...a)): EditorClient {
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
          ...(rest.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
      });
    } catch (error) {
      if (rest.signal?.aborted) throw error;
      throw new EditorApiError('network');
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw editorErrorFromResponse(response.status, body);
    return body as T;
  }

  /** One read of outline + all block pages; `consistent` is false when the revision moved. */
  async function loadOnce(
    id: string,
    revision: RevisionSelector,
    signal?: AbortSignal,
  ): Promise<{ content: DocumentContent; consistent: boolean }> {
    const outlinePromise = call<Outline>(EDITOR_PATHS.outline(id, revision), { signal });
    const blocks: ContentBlock[] = [];
    let after: number | undefined;
    let blockRevision: RevisionInfo | null = null;
    let consistent = true;
    for (let page = 0; page < MAX_BLOCK_PAGES; page += 1) {
      const list = await call<BlockList>(EDITOR_PATHS.blocks(id, revision, after), { signal });
      if (page === 0) blockRevision = list.revision;
      else if (list.revision?.id !== blockRevision?.id) consistent = false;
      blocks.push(...list.items);
      if (list.next_after === null || !consistent) break;
      after = list.next_after;
    }
    const outline = await outlinePromise;
    if (outline.revision?.id !== blockRevision?.id) consistent = false;
    return { content: { revision: blockRevision, outline: outline.items, blocks }, consistent };
  }

  return {
    getDocument: (id, signal) => call(EDITOR_PATHS.document(id), { signal }),
    async loadContent(id, revision, signal) {
      for (let attempt = 0; ; attempt += 1) {
        const { content, consistent } = await loadOnce(id, revision, signal);
        if (consistent || attempt >= 2) return content;
      }
    },
    getBlock: (id, blockId, revision) => call(EDITOR_PATHS.block(id, blockId, revision)),
    correctBlock: (id, blockId, text, baseVersion) =>
      call(EDITOR_PATHS.block(id, blockId), {
        method: 'PATCH',
        body: JSON.stringify({ text, base_version: baseVersion }),
      }),
    publish: (id, revisionId, idempotencyKey) =>
      call(EDITOR_PATHS.publish(id), {
        method: 'POST',
        body: JSON.stringify({ revision_id: revisionId }),
        idempotencyKey,
      }),
    listRevisions: async (id, signal) =>
      (await call<{ items: RevisionHistoryItem[] }>(EDITOR_PATHS.revisions(id), { signal })).items,
    restore: (id, revisionId) => call(EDITOR_PATHS.restore(id, revisionId), { method: 'POST' }),
    getSourceUrl: (id, signal) => call(EDITOR_PATHS.sourceUrl(id), { signal }),
  };
}
