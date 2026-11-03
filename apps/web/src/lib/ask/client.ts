// ASK-01 AI 질문 in the browser (docs/screens/ask-llm.md): the client of this app's same-origin
// relays (`/api/workspaces/:id/ask…`, `/api/ask/…`, src/lib/documents/bff.ts), which attach the
// session's access token server-side. FastAPI decides who may read, ask or delete (personal
// conversations, archived and feature-off workspaces) and computes the disclosure of an attached
// question; nothing here trusts or sends one. Questions, answers and passages are shown, never
// logged, stored or put into a URL.
import type { Schemas } from '@quiz/api-client';
import { parseRetryAfter } from '@/lib/search/client';

export type AskState = Schemas['AskState'];
/** A question scope (empty lists = 전체 교재); the API's own type has the lists optional. */
export interface AskScope {
  readonly document_ids: string[];
  readonly chapter_ids: string[];
}

export function normalizeScope(scope: Schemas['AskScope'] | null | undefined): AskScope {
  return { document_ids: scope?.document_ids ?? [], chapter_ids: scope?.chapter_ids ?? [] };
}
export type Conversation = Schemas['Conversation'];
export type ConversationSummary = Schemas['ConversationSummary'];
export type ConversationPage = Schemas['ConversationPage'];
export type AskMessage = Schemas['Message'];
export type AskSource = Schemas['Source'];
export type AskAttachment = Schemas['Attachment'];
/** A question to attach to a new conversation (the server checks it and decides its disclosure). */
export type AskAttachmentInput = Schemas['AttachmentInput'];
export type MessageAccepted = Schemas['MessageAccepted'];
export type FeedbackReason = Schemas['FeedbackInput']['reason'];

export const ASK_PROBLEMS = {
  archived: 'urn:quiz-workspace:problem:workspace-archived',
  disabled: 'urn:quiz-workspace:problem:ask-disabled',
  tooLong: 'urn:quiz-workspace:problem:question-too-long',
  turnLimit: 'urn:quiz-workspace:problem:ask-turn-limit',
  running: 'urn:quiz-workspace:problem:ask-answer-running',
  dailyLimit: 'urn:quiz-workspace:problem:ask-daily-limit',
  budget: 'urn:quiz-workspace:problem:ask-budget-exceeded',
  regenerateLimit: 'urn:quiz-workspace:problem:ask-regenerate-limit',
  notLast: 'urn:quiz-workspace:problem:ask-not-last-answer',
  notRetryable: 'urn:quiz-workspace:problem:ask-not-retryable',
} as const;

export type AskFailureKind =
  | 'notFound'
  | 'archived'
  | 'disabled'
  | 'tooLong'
  | 'turnLimit'
  | 'running'
  | 'dailyLimit'
  | 'rateLimited'
  | 'budget'
  | 'regenerateLimit'
  | 'notLast'
  | 'unauthenticated'
  | 'network'
  | 'failed';

export class AskApiError extends Error {
  constructor(
    readonly kind: AskFailureKind,
    readonly status = 0,
    /** 429: seconds until a retry is allowed (`Retry-After`). */
    readonly retryAfterSeconds?: number,
  ) {
    super(`AI question request failed: ${kind}`);
    this.name = 'AskApiError';
  }
}

export function classifyAskFailure(status: number, body: unknown): AskFailureKind {
  const type =
    typeof body === 'object' && body !== null ? (body as { type?: unknown }).type : undefined;
  if (status === 401) return 'unauthenticated';
  if (status === 404) return 'notFound';
  if (type === ASK_PROBLEMS.archived) return 'archived';
  if (type === ASK_PROBLEMS.disabled) return 'disabled';
  if (type === ASK_PROBLEMS.tooLong) return 'tooLong';
  if (type === ASK_PROBLEMS.turnLimit) return 'turnLimit';
  if (type === ASK_PROBLEMS.running) return 'running';
  if (type === ASK_PROBLEMS.dailyLimit) return 'dailyLimit';
  if (type === ASK_PROBLEMS.budget) return 'budget';
  if (type === ASK_PROBLEMS.regenerateLimit) return 'regenerateLimit';
  if (type === ASK_PROBLEMS.notLast) return 'notLast';
  if (status === 429) return 'rateLimited';
  if (status === 403) return 'archived';
  return 'failed';
}

// --- relay paths ---------------------------------------------------------------------------------

const enc = encodeURIComponent;
export const askPaths = {
  state: (workspaceId: string) => `/api/workspaces/${enc(workspaceId)}/ask`,
  conversations: (workspaceId: string) => `/api/workspaces/${enc(workspaceId)}/ask/conversations`,
  conversation: (id: string) => `/api/ask/conversations/${enc(id)}`,
  attachment: (id: string) => `/api/ask/conversations/${enc(id)}/attachment`,
  messages: (conversationId: string) => `/api/ask/conversations/${enc(conversationId)}/messages`,
  message: (id: string) => `/api/ask/messages/${enc(id)}`,
  stream: (id: string) => `/api/ask/messages/${enc(id)}/stream`,
  action: (id: string, action: 'cancel' | 'retry' | 'regenerate' | 'feedback') =>
    `/api/ask/messages/${enc(id)}/${action}`,
};

type FetchLike = typeof fetch;

async function call<T>(
  fetchImpl: FetchLike,
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
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
        ...init.headers,
      },
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new AskApiError('network');
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const kind = classifyAskFailure(response.status, body);
    const retryAfter =
      response.status === 429
        ? (parseRetryAfter(response.headers.get('retry-after')) ?? undefined)
        : undefined;
    throw new AskApiError(kind, response.status, retryAfter);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface AskClient {
  state(workspaceId: string, signal?: AbortSignal): Promise<AskState>;
  list(workspaceId: string, cursor: string | null, signal?: AbortSignal): Promise<ConversationPage>;
  create(
    workspaceId: string,
    body: { scope?: AskScope; attachment?: AskAttachmentInput },
  ): Promise<Conversation>;
  get(conversationId: string, signal?: AbortSignal): Promise<Conversation>;
  remove(conversationId: string): Promise<void>;
  detach(conversationId: string): Promise<Conversation>;
  ask(
    conversationId: string,
    body: { question: string; scope?: AskScope },
    idempotencyKey: string,
  ): Promise<MessageAccepted>;
  message(messageId: string, signal?: AbortSignal): Promise<AskMessage>;
  cancel(messageId: string): Promise<AskMessage>;
  again(
    messageId: string,
    action: 'retry' | 'regenerate',
    idempotencyKey: string,
  ): Promise<MessageAccepted>;
  feedback(messageId: string, reason: FeedbackReason): Promise<void>;
}

export function createAskClient(fetchImpl: FetchLike = (...a) => fetch(...a)): AskClient {
  return {
    state: (workspaceId, signal) => call(fetchImpl, askPaths.state(workspaceId), { signal }),
    list: (workspaceId, cursor, signal) =>
      call(
        fetchImpl,
        `${askPaths.conversations(workspaceId)}${cursor ? `?cursor=${enc(cursor)}` : ''}`,
        { signal },
      ),
    create: (workspaceId, body) =>
      call(fetchImpl, askPaths.conversations(workspaceId), {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    get: (conversationId, signal) =>
      call(fetchImpl, askPaths.conversation(conversationId), { signal }),
    remove: (conversationId) =>
      call(fetchImpl, askPaths.conversation(conversationId), { method: 'DELETE' }),
    detach: (conversationId) =>
      call(fetchImpl, askPaths.attachment(conversationId), { method: 'DELETE' }),
    ask: (conversationId, body, key) =>
      call(fetchImpl, askPaths.messages(conversationId), {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'idempotency-key': key },
      }),
    message: (messageId, signal) => call(fetchImpl, askPaths.message(messageId), { signal }),
    cancel: (messageId) =>
      call(fetchImpl, askPaths.action(messageId, 'cancel'), { method: 'POST' }),
    again: (messageId, action, key) =>
      call(fetchImpl, askPaths.action(messageId, action), {
        method: 'POST',
        headers: { 'idempotency-key': key },
      }),
    feedback: async (messageId, reason) => {
      await call(fetchImpl, askPaths.action(messageId, 'feedback'), {
        method: 'PUT',
        body: JSON.stringify({ reason }),
      });
    },
  };
}

// --- streaming (SSE over fetch: the relay needs no token in the URL) ------------------------------

export type AnswerEvent =
  | { readonly type: 'delta'; readonly seq: number; readonly text: string }
  | { readonly type: 'reset'; readonly seq: number }
  | { readonly type: 'done'; readonly message: AskMessage | null }
  | { readonly type: 'error'; readonly code: string };

interface RawEvent {
  readonly event: string;
  readonly id: string | null;
  readonly data: string;
}

/** Splits an SSE text buffer into complete events and the unfinished rest. */
export function splitSse(buffer: string): { events: RawEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: RawEvent[] = [];
  for (const chunk of parts) {
    let event = 'message';
    let id: string | null = null;
    const data: string[] = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length === 0 && event === 'message') continue;
    events.push({ event, id, data: data.join('\n') });
  }
  return { events, rest };
}

/** One SSE event as an answer event (null for anything else). */
export function toAnswerEvent(raw: RawEvent): AnswerEvent | null {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw.data || '{}');
    if (typeof parsed === 'object' && parsed !== null) data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const seq = typeof data.seq === 'number' ? data.seq : Number(raw.id ?? 0) || 0;
  switch (raw.event) {
    case 'delta':
      return { type: 'delta', seq, text: typeof data.text === 'string' ? data.text : '' };
    case 'reset':
      return { type: 'reset', seq };
    case 'done': {
      const message = data.message;
      return {
        type: 'done',
        message:
          typeof message === 'object' && message !== null && 'id' in message
            ? (message as AskMessage)
            : null,
      };
    }
    case 'error':
      return { type: 'error', code: typeof data.code === 'string' ? data.code : 'ask_failed' };
    default:
      return null;
  }
}

/**
 * Reads the answer's SSE relay until `done` / `error`, calling `onEvent` for each event. Resolves
 * true when a final event arrived, false when the stream ended or broke first (the caller resumes
 * with `lastEventId` or falls back to polling). Rejects only when aborted.
 */
export async function readAnswerStream(
  messageId: string,
  options: {
    readonly lastEventId?: number;
    readonly signal: AbortSignal;
    readonly onEvent: (event: AnswerEvent) => void;
    readonly fetchImpl?: FetchLike;
  },
): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? ((...a) => fetch(...a));
  let response: Response;
  try {
    response = await fetchImpl(askPaths.stream(messageId), {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        accept: 'text/event-stream',
        ...(options.lastEventId ? { 'last-event-id': String(options.lastEventId) } : {}),
      },
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    return false;
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) {
      options.onEvent({ type: 'error', code: 'not_found' });
      return true;
    }
    return false;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      // The server closes the stream right after `done` / `error`: read it to its end rather
      // than cancelling (a cancelled response loses its body in the browser's network log).
      if (done) return final;
      if (final) continue;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = splitSse(buffer);
      buffer = rest;
      for (const raw of events) {
        const event = toAnswerEvent(raw);
        if (!event) continue;
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
