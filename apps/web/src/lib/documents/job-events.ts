// Live job progress (M3.2b `GET /jobs/{id}/events`, implementation-plan §7): Server-Sent Events
// read with fetch streaming (EventSource cannot send headers and nothing goes into the URL), via
// the same-origin `/api/jobs/{id}/events` route handler that adds the Bearer token server-side.
// The server closes a stream after a terminal status or ~5 minutes; we reconnect after its
// `retry:` hint. If streaming keeps failing, `GET /jobs/{id}` polling takes over.
import { BFF_PATHS, type Job } from './client-api';
import { DocumentApiError, errorFromResponse } from './errors';

export interface SseEvent {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
}

/** Incremental `text/event-stream` parser (WHATWG HTML §9.2.6): feed decoded text chunks. */
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private event = '';
  private id: string | undefined;
  /** Last `retry:` value in milliseconds. */
  retryMs: number | undefined;

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // A lone trailing "\r" may be the first half of "\r\n": wait for more input.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.line(line);
      if (event) events.push(event);
    }
    return events;
  }

  private line(line: string): SseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) this.retryMs = Number(value);
    return null;
  }

  private dispatch(): SseEvent | null {
    const event =
      this.data.length > 0
        ? { event: this.event || 'message', data: this.data.join('\n'), id: this.id }
        : null;
    this.data = [];
    this.event = '';
    return event;
  }
}

export const TERMINAL_JOB_STATUSES: ReadonlySet<Job['status']> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

export function isTerminal(job: Pick<Job, 'status'>): boolean {
  return TERMINAL_JOB_STATUSES.has(job.status);
}

export class JobGoneError extends Error {
  constructor() {
    super('The job is no longer visible');
    this.name = 'JobGoneError';
  }
}

export interface WatchJobOptions {
  readonly onJob: (job: Job) => void;
  readonly signal: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Interval of the polling fallback. */
  readonly pollIntervalMs?: number;
  /** Consecutive stream attempts without any event before switching to polling. */
  readonly maxStreamFailures?: number;
}

const DEFAULT_RETRY_MS = 2000;

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Follows a job until it is terminal and returns its final state. Calls `onJob` for every
 * update. Rejects with `JobGoneError` (job deleted / access lost), `DocumentApiError`
 * (`unauthenticated` and other definitive answers) or the abort reason.
 */
export async function watchJob(jobId: string, options: WatchJobOptions): Promise<Job> {
  const {
    onJob,
    signal,
    fetchImpl = (...a) => fetch(...a),
    sleep = abortableSleep,
    pollIntervalMs = 2000,
    maxStreamFailures = 2,
  } = options;
  let failures = 0;
  let retryMs = DEFAULT_RETRY_MS;

  while (failures < maxStreamFailures) {
    signal.throwIfAborted();
    const outcome = await streamOnce(jobId, fetchImpl, signal, onJob);
    if (outcome.retryMs !== undefined) retryMs = outcome.retryMs;
    if (outcome.final) return outcome.final;
    failures = outcome.received ? 0 : failures + 1;
    await sleep(retryMs, signal);
  }

  // Polling fallback: the stream is unavailable (proxy buffering, network policy, ...).
  for (;;) {
    signal.throwIfAborted();
    try {
      const job = await getJob(jobId, fetchImpl, signal);
      onJob(job);
      if (isTerminal(job)) return job;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof DocumentApiError && error.kind === 'notFound') throw new JobGoneError();
      if (error instanceof DocumentApiError && !error.retryable) throw error;
    }
    await sleep(pollIntervalMs, signal);
  }
}

interface StreamOutcome {
  readonly final?: Job;
  readonly received: boolean;
  readonly retryMs?: number;
}

async function streamOnce(
  jobId: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  onJob: (job: Job) => void,
): Promise<StreamOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(BFF_PATHS.jobEvents(jobId), {
      headers: { accept: 'text/event-stream' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch {
    signal.throwIfAborted();
    return { received: false };
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const error = errorFromResponse(response.status, body);
    if (error.kind === 'notFound') throw new JobGoneError();
    if (!error.retryable) throw error;
    return { received: false };
  }
  if (!response.body) return { received: false };

  const parser = new SseParser();
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let received = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of parser.feed(value)) {
        if (event.event === 'gone') throw new JobGoneError();
        if (event.event !== 'job') continue;
        let job: Job;
        try {
          job = JSON.parse(event.data) as Job;
        } catch {
          continue;
        }
        received = true;
        onJob(job);
        if (isTerminal(job)) return { final: job, received, retryMs: parser.retryMs };
      }
    }
  } catch (error) {
    if (error instanceof JobGoneError) throw error;
    signal.throwIfAborted();
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return { received, retryMs: parser.retryMs };
}

async function getJob(jobId: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<Job> {
  let response: Response;
  try {
    response = await fetchImpl(BFF_PATHS.job(jobId), {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch {
    signal.throwIfAborted();
    throw new DocumentApiError('network');
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw errorFromResponse(response.status, body);
  return body as Job;
}
