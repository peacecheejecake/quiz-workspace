// Browser side of WS-VIEW-01. Every call goes to this origin's `/api/shared/{id}/…` relay
// (src/lib/shared/bff.ts), never to FastAPI. The share session is the HttpOnly
// `quiz_share_session` cookie scoped to that relay path, so only these same-origin fetches carry
// it; page code never sees it. The link secret travels once, in the body of the session exchange,
// and is never put in a URL, storage, a log line or an error message.
import type { Schemas } from '@quiz/api-client';
import { PdfLoadError } from '@/lib/documents/pdf-source';
import { RESULT_LIMIT, parseRetryAfter } from '@/lib/search/client';

export type SharedWorkspace = Schemas['SharedWorkspace'];
export type SharedDocumentSummary = Schemas['SharedDocumentSummary'];
export type SharedDocument = Schemas['SharedDocument'];
export type SharedQuestion = Schemas['SharedQuestion'];
export type SharedQuestionList = Schemas['SharedQuestionList'];
export type SharedSearchResponse = Schemas['SharedSearchResponse'];
export type ContentBlock = Schemas['ContentBlock'];
export type OutlineItem = Schemas['OutlineItem'];

export const SHARE_UNAVAILABLE = 'urn:quiz-workspace:problem:share-unavailable';
export const SHARE_SESSION_REQUIRED = 'urn:quiz-workspace:problem:share-session-required';

/** Blocks per document request (the API's maximum). */
export const SHARED_BLOCK_PAGE = 500;
/** Upper bound of block pages read for one document (50 000 blocks). */
export const MAX_BLOCK_PAGES = 100;
export const SHARED_QUESTION_PAGE = 100;
/** Upload limit is 50 MiB; anything far beyond is not ours. */
const MAX_PDF_BYTES = 64 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isShareId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * - `unavailable`: the link is wrong, expired, revoked or deleted (one answer for all of them),
 *   or the browser has no session for it and no fragment to start one;
 * - `sessionRequired`: no share session yet (exchange the fragment if there is one);
 * - `notFound`: a document/question that is not part of the share;
 * - `rateLimited`, `network`, `failed`: retryable.
 */
export type SharedFailureKind =
  'unavailable' | 'sessionRequired' | 'notFound' | 'rateLimited' | 'network' | 'failed';

export class SharedApiError extends Error {
  constructor(
    readonly kind: SharedFailureKind,
    readonly status = 0,
    /** 429: seconds until a retry is allowed (from `Retry-After`). */
    readonly retryAfterSeconds?: number,
  ) {
    super(`Shared request failed: ${kind}`);
    this.name = 'SharedApiError';
  }
}

export function classifySharedFailure(status: number, body: unknown): SharedFailureKind {
  const type =
    typeof body === 'object' && body !== null ? (body as { type?: unknown }).type : undefined;
  if (type === SHARE_UNAVAILABLE) return 'unavailable';
  if (status === 401) return type === SHARE_SESSION_REQUIRED ? 'sessionRequired' : 'unavailable';
  if (status === 404) return 'notFound';
  if (status === 429) return 'rateLimited';
  return 'failed';
}

/**
 * The `k` value of a share URL fragment (`#k=<secret>`), or null. Only base64url characters are
 * accepted, so nothing else from the fragment is ever sent anywhere.
 */
export function readShareSecret(hash: string): string | null {
  if (!hash.startsWith('#')) return null;
  const value = new URLSearchParams(hash.slice(1)).get('k');
  return value !== null && /^[A-Za-z0-9_-]{16,512}$/.test(value) ? value : null;
}

/** The current address without its fragment (what replaceState writes back). */
export function withoutFragment(location: Pick<Location, 'pathname' | 'search'>): string {
  return `${location.pathname}${location.search}`;
}

type FetchLike = typeof fetch;

export interface SharedClient {
  /** Exchanges the fragment secret for the HttpOnly share session cookie. */
  exchange(secret: string, signal?: AbortSignal): Promise<void>;
  workspace(signal?: AbortSignal): Promise<SharedWorkspace>;
  /** The published revision of a document with all of its blocks (read page by page). */
  document(documentId: string, signal?: AbortSignal): Promise<SharedDocument>;
  questions(cursor: string | null, signal?: AbortSignal): Promise<SharedQuestionList>;
  search(query: string, signal?: AbortSignal): Promise<SharedSearchResponse>;
  /**
   * The original PDF bytes. Rejects with {@link SharedApiError} when the link or session is no
   * longer usable, else with {@link PdfLoadError}.
   */
  pdf(documentId: string, signal: AbortSignal): Promise<Uint8Array>;
}

export function sharedBase(shareId: string): string {
  return `/api/shared/${encodeURIComponent(shareId)}`;
}

export function createSharedClient(
  shareId: string,
  fetchImpl: FetchLike = (...a) => fetch(...a),
  now: () => number = Date.now,
): SharedClient {
  const base = sharedBase(shareId);

  async function send(path: string, init: RequestInit, accept = 'application/json') {
    try {
      return await fetchImpl(`${base}${path}`, {
        ...init,
        credentials: 'same-origin',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: {
          accept,
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new SharedApiError('network');
    }
  }

  async function fail(response: Response): Promise<never> {
    const body: unknown = await response.json().catch(() => undefined);
    const kind = classifySharedFailure(response.status, body);
    const retryAfter =
      kind === 'rateLimited'
        ? (parseRetryAfter(response.headers.get('retry-after'), now()) ?? undefined)
        : undefined;
    throw new SharedApiError(kind, response.status, retryAfter);
  }

  async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await send(path, init);
    if (!response.ok) return fail(response);
    return (await response.json()) as T;
  }

  async function loadDocument(
    documentId: string,
    signal?: AbortSignal,
    attempt = 0,
  ): Promise<SharedDocument> {
    const path = `/documents/${encodeURIComponent(documentId)}`;
    const first = await json<SharedDocument>(`${path}?limit=${SHARED_BLOCK_PAGE}`, { signal });
    const blocks = [...first.blocks];
    let after = first.next_after;
    for (let n = 1; after !== null && n < MAX_BLOCK_PAGES; n += 1) {
      const next = await json<SharedDocument>(`${path}?limit=${SHARED_BLOCK_PAGE}&after=${after}`, {
        signal,
      });
      // A publish between two pages would mix revisions: start over once with the new one.
      if (next.revision_id !== first.revision_id) {
        if (attempt > 0) throw new SharedApiError('failed');
        return loadDocument(documentId, signal, attempt + 1);
      }
      blocks.push(...next.blocks);
      after = next.next_after;
    }
    return { ...first, blocks, next_after: null };
  }

  return {
    async exchange(secret, signal) {
      const response = await send('/sessions', {
        method: 'POST',
        body: JSON.stringify({ secret }),
        signal,
      });
      if (!response.ok) await fail(response);
    },
    workspace: (signal) => json<SharedWorkspace>('', { signal }),
    document: (documentId, signal) => loadDocument(documentId, signal),
    questions: (cursor, signal) =>
      json<SharedQuestionList>(
        `/questions?limit=${SHARED_QUESTION_PAGE}${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
        }`,
        { signal },
      ),
    search: (query, signal) =>
      json<SharedSearchResponse>('/search', {
        method: 'POST',
        body: JSON.stringify({ query, mode: 'hybrid', limit: RESULT_LIMIT }),
        signal,
      }),
    async pdf(documentId, signal) {
      let response: Response;
      try {
        response = await send(
          `/documents/${encodeURIComponent(documentId)}/pdf`,
          { signal },
          'application/pdf',
        );
      } catch (error) {
        if (signal.aborted) throw error;
        throw new PdfLoadError('network');
      }
      if (!response.ok) {
        // A refused link or ended session ends the whole share view; anything else stays a
        // local PDF error the viewer shows with a retry.
        const body: unknown = await response.json().catch(() => undefined);
        const kind = classifySharedFailure(response.status, body);
        if (kind === 'unavailable' || kind === 'sessionRequired') {
          throw new SharedApiError(kind, response.status);
        }
        throw new PdfLoadError('unavailable');
      }
      if (Number(response.headers.get('content-length') ?? 0) > MAX_PDF_BYTES) {
        await response.body?.cancel();
        throw new PdfLoadError('tooLarge');
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
