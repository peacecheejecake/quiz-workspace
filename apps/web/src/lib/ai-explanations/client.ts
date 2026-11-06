// AIEXPL-01 AI 해설 in the browser (docs/screens/ai-explanations.md): the client of this app's
// same-origin relays (`/api/questions/:id/ai-explanation…`, `/api/mock-exam-questions/:id/…`,
// `/api/ai-explanations/:id/stream`, `/api/mock-ai-explanations/:id/stream`, the share relay),
// which attach the session's access token server-side. FastAPI decides the gate (a submitted
// session, `view: detail` / `view: manage`), the cache and the limits; nothing here trusts or
// computes one. Explanations are shown, never logged, stored or put into a URL.
import type { Schemas } from '@quiz/api-client';
import { splitSse } from '@/lib/ask/client';
import { parseRetryAfter } from '@/lib/search/client';

export type ExplanationBody = Schemas['ExplanationBody'];
export type ExplanationSource = Schemas['ExplanationSource'];
export type SharedExplanation = Schemas['SharedExplanation'];
/** A bank question's or a mock exam question's explanation (their revision id differs). */
export type Explanation = Schemas['Explanation'] | Schemas['MockExplanation'];

export interface ExplanationState {
  readonly available: boolean;
  readonly can_create: boolean;
  readonly can_regenerate: boolean;
  readonly can_cancel: boolean;
  readonly explanation: Explanation | null;
}

/** What is explained: a registered question or a mock exam question (its own rows, C09). */
export interface ExplanationTarget {
  readonly kind: 'question' | 'mock';
  readonly id: string;
}

/** Why the caller may see it (the server re-checks every request). */
export type ExplanationGate =
  | { readonly practice_session_id: string }
  | { readonly mock_practice_session_id: string }
  | { readonly view: 'detail' | 'manage' };

const PROBLEM = 'urn:quiz-workspace:problem:';
export const EXPLANATION_PROBLEMS = {
  beforeSubmit: `${PROBLEM}explanation-before-submit`,
  unavailable: `${PROBLEM}explanation-unavailable`,
  disabled: `${PROBLEM}explanation-disabled`,
  regenerateLimit: `${PROBLEM}explanation-regenerate-limit`,
  dailyLimit: `${PROBLEM}explanation-daily-limit`,
  budget: `${PROBLEM}explanation-budget-exceeded`,
  archived: `${PROBLEM}workspace-archived`,
  insufficientRole: `${PROBLEM}insufficient-role`,
} as const;

export type ExplanationFailureKind =
  | 'beforeSubmit'
  | 'unavailable'
  | 'disabled'
  | 'regenerateLimit'
  | 'dailyLimit'
  | 'budget'
  | 'rateLimited'
  | 'archived'
  | 'insufficientRole'
  | 'notFound'
  | 'unauthenticated'
  | 'network'
  | 'failed';

export class ExplanationApiError extends Error {
  constructor(
    readonly kind: ExplanationFailureKind,
    readonly status = 0,
    /** 429: seconds until a retry is allowed (`Retry-After`). */
    readonly retryAfterSeconds?: number,
  ) {
    super(`AI explanation request failed: ${kind}`);
    this.name = 'ExplanationApiError';
  }
}

export function classifyExplanationFailure(status: number, body: unknown): ExplanationFailureKind {
  const type =
    typeof body === 'object' && body !== null ? (body as { type?: unknown }).type : undefined;
  if (status === 401) return 'unauthenticated';
  if (status === 404) return 'notFound';
  for (const [kind, urn] of Object.entries(EXPLANATION_PROBLEMS)) {
    if (type === urn) return kind as ExplanationFailureKind;
  }
  if (status === 429) return 'rateLimited';
  return 'failed';
}

const enc = encodeURIComponent;

export const explanationPaths = {
  base: (target: ExplanationTarget) =>
    target.kind === 'question'
      ? `/api/questions/${enc(target.id)}/ai-explanation`
      : `/api/mock-exam-questions/${enc(target.id)}/ai-explanation`,
  stream: (kind: ExplanationTarget['kind'], explanationId: string) =>
    kind === 'question'
      ? `/api/ai-explanations/${enc(explanationId)}/stream`
      : `/api/mock-ai-explanations/${enc(explanationId)}/stream`,
  shared: (shareId: string, questionId: string) =>
    `/api/shared/${enc(shareId)}/questions/${enc(questionId)}/ai-explanation`,
};

export function gateQuery(gate: ExplanationGate): string {
  return `?${new URLSearchParams(Object.entries(gate)).toString()}`;
}

type FetchLike = typeof fetch;

async function call<T>(
  fetchImpl: FetchLike,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
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
    throw new ExplanationApiError('network');
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const retryAfter =
      response.status === 429
        ? (parseRetryAfter(response.headers.get('retry-after')) ?? undefined)
        : undefined;
    throw new ExplanationApiError(
      classifyExplanationFailure(response.status, body),
      response.status,
      retryAfter,
    );
  }
  return { status: response.status, body: (await response.json()) as T };
}

export interface ExplanationClient {
  state(
    target: ExplanationTarget,
    gate: ExplanationGate,
    signal?: AbortSignal,
  ): Promise<ExplanationState>;
  /** Makes it (or joins the one being made; a cache hit answers the stored one). */
  create(target: ExplanationTarget, gate: ExplanationGate): Promise<ExplanationState>;
  /** `다시 만들기`: a new version (owner/editor). */
  regenerate(target: ExplanationTarget, gate: ExplanationGate): Promise<ExplanationState>;
  /** `취소`: stops the one being made and answers the state after it (UX12-EXPLCANCEL). */
  cancel(
    target: ExplanationTarget,
    gate: ExplanationGate,
    explanationId: string,
  ): Promise<ExplanationState>;
  /** A share guest's read of an existing explanation (null: there is none). */
  shared(
    shareId: string,
    questionId: string,
    signal?: AbortSignal,
  ): Promise<SharedExplanation | null>;
}

export function createExplanationClient(
  fetchImpl: FetchLike = (...a) => fetch(...a),
): ExplanationClient {
  return {
    state: async (target, gate, signal) =>
      (
        await call<ExplanationState>(
          fetchImpl,
          `${explanationPaths.base(target)}${gateQuery(gate)}`,
          { signal },
        )
      ).body,
    create: async (target, gate) =>
      (
        await call<ExplanationState>(fetchImpl, explanationPaths.base(target), {
          method: 'POST',
          body: JSON.stringify(gate),
        })
      ).body,
    regenerate: async (target, gate) =>
      (
        await call<ExplanationState>(fetchImpl, `${explanationPaths.base(target)}/regenerate`, {
          method: 'POST',
          body: JSON.stringify(gate),
        })
      ).body,
    cancel: async (target, gate, explanationId) =>
      (
        await call<ExplanationState>(fetchImpl, `${explanationPaths.base(target)}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ ...gate, explanation_id: explanationId }),
        })
      ).body,
    shared: async (shareId, questionId, signal) => {
      try {
        return (
          await call<SharedExplanation>(fetchImpl, explanationPaths.shared(shareId, questionId), {
            signal,
            referrerPolicy: 'no-referrer',
          })
        ).body;
      } catch (error) {
        if (error instanceof ExplanationApiError && error.kind === 'notFound') return null;
        throw error;
      }
    },
  };
}

// --- streaming (SSE over fetch: the relay needs no token in the URL) ------------------------------

export type ExplanationEvent =
  | { readonly type: 'delta'; readonly seq: number; readonly text: string }
  | { readonly type: 'reset' }
  | { readonly type: 'done'; readonly explanation: Explanation | null }
  | { readonly type: 'error'; readonly code: string };

/** One SSE event as an explanation event (null for anything else). */
export function toExplanationEvent(raw: { event: string; data: string }): ExplanationEvent | null {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw.data || '{}');
    if (typeof parsed === 'object' && parsed !== null) data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (raw.event) {
    case 'delta':
      return {
        type: 'delta',
        seq: typeof data.seq === 'number' ? data.seq : 0,
        text: typeof data.text === 'string' ? data.text : '',
      };
    case 'reset':
      return { type: 'reset' };
    case 'done': {
      const explanation = data.explanation;
      return {
        type: 'done',
        explanation:
          typeof explanation === 'object' && explanation !== null && 'id' in explanation
            ? (explanation as Explanation)
            : null,
      };
    }
    case 'error':
      return {
        type: 'error',
        code: typeof data.code === 'string' ? data.code : 'explanation_failed',
      };
    default:
      return null;
  }
}

/**
 * Reads an explanation's SSE relay until `done` / `error`, calling `onEvent` for each event and
 * `onId` with each event id (for `Last-Event-ID`). Resolves true when a final event arrived,
 * false when the stream ended or broke first (the caller resumes or reads the state again).
 * Rejects only when aborted.
 */
export async function readExplanationStream(
  kind: ExplanationTarget['kind'],
  explanationId: string,
  gate: ExplanationGate,
  options: {
    readonly lastEventId?: number;
    readonly signal: AbortSignal;
    readonly onEvent: (event: ExplanationEvent) => void;
    readonly onId?: (id: number) => void;
    readonly fetchImpl?: FetchLike;
  },
): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? ((...a) => fetch(...a));
  let response: Response;
  try {
    response = await fetchImpl(
      `${explanationPaths.stream(kind, explanationId)}${gateQuery(gate)}`,
      {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          accept: 'text/event-stream',
          ...(options.lastEventId ? { 'last-event-id': String(options.lastEventId) } : {}),
        },
        signal: options.signal,
      },
    );
  } catch (error) {
    if (options.signal.aborted) throw error;
    return false;
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      // The server closes the stream right after `done` / `error`: read it to its end.
      if (done) return final;
      if (final) continue;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = splitSse(buffer);
      buffer = rest;
      for (const raw of events) {
        const event = toExplanationEvent(raw);
        if (!event) continue;
        const id = raw.id === null ? NaN : Number(raw.id);
        if (Number.isFinite(id)) options.onId?.(id);
        options.onEvent(event);
        if (event.type === 'done' || event.type === 'error') {
          final = true;
          break;
        }
      }
    }
  } catch (error) {
    reader.cancel().catch(() => undefined);
    if (options.signal.aborted) throw error;
    return final;
  }
}
