// Browser side of SEARCH-01. Calls go to this app's own `/api/workspaces/{id}/search` relay
// (src/lib/documents/bff.ts), which attaches the session's access token server-side; FastAPI
// enforces the workspace scope and the published-revision filter.
import type { Problem, Schemas } from '@quiz/api-client';

export type SearchMode = Schemas['SearchRequest']['mode'] & string;
export type SearchItem = Schemas['SearchItem'];
export type SearchResponse = Schemas['SearchResponse'];
export type OutlineItem = Schemas['OutlineItem'];
export type ContentBlock = Schemas['ContentBlock'];

export const SEARCH_MODES = [
  'keyword',
  'semantic',
  'hybrid',
] as const satisfies readonly SearchMode[];
export const DEFAULT_MODE: SearchMode = 'hybrid';
export const RESULT_LIMIT = 20;

export interface SearchQuery {
  readonly query: string;
  readonly mode: SearchMode;
  readonly documentId: string | null;
  readonly chapterId: string | null;
  readonly includeQuestionPapers: boolean;
}

/** Request body of `POST /workspaces/{id}/search` for `q` (filters only when set). */
export function searchBody(q: SearchQuery): Schemas['SearchRequest'] {
  return {
    query: q.query,
    mode: q.mode,
    limit: RESULT_LIMIT,
    include_question_papers: q.includeQuestionPapers,
    ...(q.documentId ? { document_ids: [q.documentId] } : {}),
    ...(q.chapterId ? { chapter_ids: [q.chapterId] } : {}),
  };
}

export type SearchFailureKind =
  | 'network'
  | 'unauthenticated'
  | 'notFound'
  | 'filterNotFound'
  | 'invalid'
  | 'rateLimited'
  | 'unavailable';

export class SearchApiError extends Error {
  constructor(
    readonly kind: SearchFailureKind,
    readonly status = 0,
    /** 429: seconds until a retry is allowed (from `Retry-After`). */
    readonly retryAfterSeconds?: number,
  ) {
    super(`Search failed: ${kind}`);
    this.name = 'SearchApiError';
  }
}

/** `Retry-After` as delay-seconds or an HTTP-date; null when missing or malformed. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

const FILTER_NOT_FOUND = /^(document|chapter) not found/i;

export function classifySearchFailure(status: number, body: unknown): SearchFailureKind {
  const detail =
    typeof body === 'object' && body !== null ? (body as Partial<Problem>).detail : undefined;
  if (status === 401) return 'unauthenticated';
  if (status === 404 || status === 403)
    return typeof detail === 'string' && FILTER_NOT_FOUND.test(detail)
      ? 'filterNotFound'
      : 'notFound';
  if (status === 400 || status === 422) return 'invalid';
  if (status === 429) return 'rateLimited';
  return 'unavailable';
}

export const searchPath = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/search`;

export const outlinePath = (documentId: string) =>
  `/api/documents/${encodeURIComponent(documentId)}/outline?revision=active`;

export const blockPath = (documentId: string, blockId: string, revisionId: string) =>
  `/api/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(
    blockId,
  )}?revision=${encodeURIComponent(revisionId)}`;

type FetchLike = typeof fetch;

async function call<T>(
  fetchImpl: FetchLike,
  path: string,
  init: RequestInit,
  now: () => number,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new SearchApiError('network');
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const kind = classifySearchFailure(response.status, body);
    const retryAfter =
      kind === 'rateLimited'
        ? (parseRetryAfter(response.headers.get('retry-after'), now()) ?? undefined)
        : undefined;
    throw new SearchApiError(kind, response.status, retryAfter);
  }
  return body as T;
}

export interface SearchClient {
  search(workspaceId: string, q: SearchQuery, signal?: AbortSignal): Promise<SearchResponse>;
  /** Chapters (top-level outline nodes) of the document's published revision. */
  chapters(documentId: string, signal?: AbortSignal): Promise<OutlineItem[]>;
  /** One canonical block of a given revision (the hit's published revision). */
  block(
    documentId: string,
    blockId: string,
    revisionId: string,
    signal?: AbortSignal,
  ): Promise<ContentBlock>;
}

export function createSearchClient(
  fetchImpl: FetchLike = (...a) => fetch(...a),
  now: () => number = Date.now,
): SearchClient {
  return {
    search: (workspaceId, q, signal) =>
      call(
        fetchImpl,
        searchPath(workspaceId),
        { method: 'POST', body: JSON.stringify(searchBody(q)), signal },
        now,
      ),
    chapters: async (documentId, signal) =>
      (await call<{ items: OutlineItem[] }>(fetchImpl, outlinePath(documentId), { signal }, now))
        .items,
    block: async (documentId, blockId, revisionId, signal) =>
      (
        await call<{ block: ContentBlock }>(
          fetchImpl,
          blockPath(documentId, blockId, revisionId),
          { signal },
          now,
        )
      ).block,
  };
}
