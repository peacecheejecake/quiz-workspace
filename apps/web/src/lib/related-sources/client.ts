// RELSRC-01 관련 본문 in the browser (docs/screens/related-sources.md): the client of this app's
// same-origin relays (`/api/questions/:id/related-sources`, `/api/mock-exam-questions/:id/…`, the
// share relay), which attach the session's access token server-side. FastAPI decides the gate (a
// submitted session, `view: detail` / `view: manage`) and the cache; nothing here trusts or
// computes one. The lists are shown, never logged, stored or put into a URL.
import type { Schemas } from '@quiz/api-client';
import {
  gateQuery,
  type ExplanationGate,
  type ExplanationTarget,
} from '@/lib/ai-explanations/client';

export type RelatedSource = Schemas['RelatedSource'];
export type SharedRelatedSource = Schemas['SharedRelatedSource'];

/** A bank question's or a mock exam question's list, as the one shape the area shows. */
export interface RelatedList {
  readonly items: readonly RelatedSource[];
  /** `dense_unavailable`: keyword (BM25) results only. */
  readonly degraded: readonly string[];
}

export class RelatedApiError extends Error {
  constructor(
    readonly kind: 'notFound' | 'failed',
    readonly status = 0,
  ) {
    super(`related sources request failed: ${kind}`);
    this.name = 'RelatedApiError';
  }
}

const enc = encodeURIComponent;

export const relatedPaths = {
  base: (target: ExplanationTarget) =>
    target.kind === 'question'
      ? `/api/questions/${enc(target.id)}/related-sources`
      : `/api/mock-exam-questions/${enc(target.id)}/related-sources`,
  shared: (shareId: string, questionId: string) =>
    `/api/shared/${enc(shareId)}/questions/${enc(questionId)}/related-sources`,
};

type FetchLike = typeof fetch;

async function read<T>(fetchImpl: FetchLike, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new RelatedApiError('failed');
  }
  if (!response.ok) {
    throw new RelatedApiError(response.status === 404 ? 'notFound' : 'failed', response.status);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new RelatedApiError('failed', response.status);
  }
}

export interface RelatedClient {
  /** The list for a question (computed and stored on the first read after a submission). */
  list(
    target: ExplanationTarget,
    gate: ExplanationGate,
    signal?: AbortSignal,
  ): Promise<RelatedList>;
  /** A share guest's read of an already stored list (null: there is none). */
  shared(
    shareId: string,
    questionId: string,
    signal?: AbortSignal,
  ): Promise<readonly SharedRelatedSource[] | null>;
}

export function createRelatedClient(fetchImpl: FetchLike = (...a) => fetch(...a)): RelatedClient {
  return {
    list: async (target, gate, signal) => {
      const body = await read<{ items: RelatedSource[]; degraded?: string[] }>(
        fetchImpl,
        `${relatedPaths.base(target)}${gateQuery(gate)}`,
        { signal },
      );
      if (!Array.isArray(body.items)) throw new RelatedApiError('failed');
      return { items: body.items, degraded: body.degraded ?? [] };
    },
    shared: async (shareId, questionId, signal) => {
      try {
        return (
          await read<{ items: SharedRelatedSource[] }>(
            fetchImpl,
            relatedPaths.shared(shareId, questionId),
            { signal, referrerPolicy: 'no-referrer' },
          )
        ).items;
      } catch (error) {
        if (error instanceof RelatedApiError && error.kind === 'notFound') return null;
        throw error;
      }
    },
  };
}
