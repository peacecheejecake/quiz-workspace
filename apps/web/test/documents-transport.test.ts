// DOC-01 (M3.3): direct Storage upload transports (PUT with progress/abort, TUS resume), the
// job event stream parser/reconnect/polling fallback, and the same-origin API relay.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../src/lib/documents/client-api';
import { DocumentApiError } from '../src/lib/documents/errors';
import { JobGoneError, SseParser, watchJob } from '../src/lib/documents/job-events';
import {
  TUS_CHUNK_BYTES,
  UploadAbortedError,
  isAlreadyStored,
  putTransfer,
  tusTransfer,
} from '../src/lib/documents/transport';

// --- PUT ----------------------------------------------------------------------------------------

class FakeXhr {
  static last: FakeXhr;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  status = 0;
  responseText = '';
  body: unknown;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  respond(status: number, text = '') {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
}

const xhrFactory = () => new FakeXhr() as unknown as XMLHttpRequest;
const file = new Blob(['%PDF-1.7 0123456789']);
const intent = {
  upload_url: 'http://127.0.0.1:54321/storage/v1/object/upload/sign/key?token=t',
  upload_headers: { 'content-type': 'application/pdf' },
};

describe('putTransfer', () => {
  it('PUTs the bytes with the intent headers and reports progress', async () => {
    const progress: number[] = [];
    const run = putTransfer(file, intent, xhrFactory).run({
      signal: new AbortController().signal,
      onProgress: (loaded) => progress.push(loaded),
    });
    const xhr = FakeXhr.last;
    expect([xhr.method, xhr.url, xhr.headers, xhr.body]).toEqual([
      'PUT',
      intent.upload_url,
      intent.upload_headers,
      file,
    ]);
    xhr.upload.onprogress?.({
      loaded: 4,
      total: file.size,
      lengthComputable: true,
    } as ProgressEvent);
    xhr.respond(200);
    await run;
    expect(progress).toEqual([4, file.size]);
  });

  it('treats "already stored" as success so a retry after a lost response can complete', async () => {
    const run = putTransfer(file, intent, xhrFactory).run({
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    FakeXhr.last.respond(400, JSON.stringify({ statusCode: '409', error: 'Duplicate' }));
    await expect(run).resolves.toBeUndefined();
    expect(isAlreadyStored(400, '{"statusCode":"403"}')).toBe(false);
    expect(isAlreadyStored(400, 'not json')).toBe(false);
  });

  it('reports network drops as retryable and storage rejections as storage errors', async () => {
    const dropped = putTransfer(file, intent, xhrFactory).run({
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    FakeXhr.last.onerror?.();
    await expect(dropped).rejects.toMatchObject({ kind: 'network', retryable: true });

    const rejected = putTransfer(file, intent, xhrFactory).run({
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    FakeXhr.last.respond(403, '{"statusCode":"403"}');
    await expect(rejected).rejects.toMatchObject({ kind: 'storage', status: 403 });
  });

  it('aborts the request on cancel', async () => {
    const controller = new AbortController();
    const run = putTransfer(file, intent, xhrFactory).run({
      signal: controller.signal,
      onProgress: () => undefined,
    });
    controller.abort();
    await expect(run).rejects.toBeInstanceOf(UploadAbortedError);
  });
});

// --- TUS ----------------------------------------------------------------------------------------

function firstInstance<T>(list: readonly T[]): T {
  const [first] = list;
  if (!first) throw new Error('no tus upload created');
  return first;
}

describe('tusTransfer', () => {
  const tusIntent = {
    upload_id: 'u-1',
    resumable: {
      endpoint: 'http://127.0.0.1:54321/storage/v1/upload/resumable/sign',
      headers: { 'x-signature': 'sig' },
      metadata: { bucketName: 'source-pdfs', objectName: 'k', contentType: 'application/pdf' },
    },
  };

  function fakeTus(outcomes: ('success' | 'network')[]) {
    const instances: { options: Record<string, unknown>; starts: number }[] = [];
    interface Callbacks {
      onProgress(loaded: number, total: number): void;
      onSuccess(): void;
      onError(error: Error): void;
    }
    class Upload {
      options: Record<string, unknown> & Callbacks;
      starts = 0;
      constructor(_file: Blob, options: Record<string, unknown>) {
        this.options = options as Record<string, unknown> & Callbacks;
        instances.push(this);
      }
      start() {
        this.starts += 1;
        const outcome = outcomes.shift();
        queueMicrotask(() => {
          if (outcome === 'success') {
            this.options.onProgress(10, 20);
            this.options.onSuccess();
          } else {
            this.options.onError(
              Object.assign(new Error('tus: failed'), { originalResponse: null }),
            );
          }
        });
      }
      abort() {
        return Promise.resolve();
      }
    }
    return { module: { Upload } as never, instances };
  }

  it('uploads in 6 MiB chunks with the intent signature and never stores resume state', async () => {
    const tus = fakeTus(['success']);
    const progress: number[] = [];
    await tusTransfer(file, tusIntent, async () => tus.module).run({
      signal: new AbortController().signal,
      onProgress: (loaded) => progress.push(loaded),
    });
    const options = firstInstance(tus.instances).options;
    expect(options).toMatchObject({
      endpoint: tusIntent.resumable.endpoint,
      headers: { 'x-signature': 'sig' },
      metadata: tusIntent.resumable.metadata,
      chunkSize: TUS_CHUNK_BYTES,
      storeFingerprintForResuming: false,
    });
    expect(await (options.fingerprint as () => Promise<string>)()).toBe('quiz-upload-u-1');
    expect(progress).toEqual([10, file.size]);
  });

  it('resumes the same tus upload on retry after a network failure', async () => {
    const tus = fakeTus(['network', 'success']);
    const transfer = tusTransfer(file, tusIntent, async () => tus.module);
    const options = { signal: new AbortController().signal, onProgress: () => undefined };
    await expect(transfer.run(options)).rejects.toMatchObject({ kind: 'network' });
    await transfer.run(options);
    expect(tus.instances).toHaveLength(1);
    expect(firstInstance(tus.instances).starts).toBe(2);
  });

  it('does not start the upload when cancelled while the tus module is loading', async () => {
    const tus = fakeTus(['success']);
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => (release = resolve));
    const controller = new AbortController();
    const run = tusTransfer(file, tusIntent, async () => {
      await loaded;
      return tus.module;
    }).run({ signal: controller.signal, onProgress: () => undefined });
    controller.abort();
    release();
    await expect(run).rejects.toBeInstanceOf(UploadAbortedError);
    expect(tus.instances).toHaveLength(0);
  });
});

// --- SSE ----------------------------------------------------------------------------------------

describe('SseParser', () => {
  it('parses events split across chunks, CRLF, comments, multi-line data and retry', () => {
    const parser = new SseParser();
    expect(parser.feed('retry: 2000\n\n: keep-alive\n\nid: 1\nevent: jo')).toEqual([]);
    expect(parser.feed('b\r\ndata: {"a":\r')).toEqual([]);
    expect(parser.feed('\ndata: 1}\r\n\r\n')).toEqual([
      { event: 'job', data: '{"a":\n1}', id: '1' },
    ]);
    expect(parser.retryMs).toBe(2000);
    expect(parser.feed('data:x\n\nevent: gone\ndata: {}\n\n')).toEqual([
      { event: 'message', data: 'x', id: '1' },
      { event: 'gone', data: '{}', id: '1' },
    ]);
  });
});

function job(status: Job['status'], progress: number | null = null): Job {
  return {
    id: 'j',
    job_type: 'document.parse',
    status,
    progress,
    stage: null,
    error_code: null,
    attempts: 1,
    max_attempts: 3,
    cancel_requested: false,
    created_at: '2026-10-17T00:00:00Z',
    updated_at: '2026-10-17T00:00:00Z',
    started_at: null,
    finished_at: null,
  };
}

const sse = (...jobs: Job[]) =>
  'retry: 10\n\n' +
  jobs.map((j, i) => `id: ${i}\nevent: job\ndata: ${JSON.stringify(j)}\n\n`).join('');

function streamResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('watchJob', () => {
  const noSleep = vi.fn(async () => undefined);
  beforeEach(() => noSleep.mockClear());

  it('streams job updates through the same-origin relay until terminal', async () => {
    const fetchImpl = vi.fn(async () =>
      streamResponse(sse(job('queued'), job('running', 50), job('succeeded', 100))),
    );
    const seen: string[] = [];
    const final = await watchJob('j', {
      signal: new AbortController().signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      onJob: (j) => seen.push(j.status),
    });
    expect(final.status).toBe('succeeded');
    expect(seen).toEqual(['queued', 'running', 'succeeded']);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/jobs/j/events');
    // No token in the URL or headers: the relay authenticates with the HttpOnly session.
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|bearer/i);
  });

  it('reconnects after the server closes a stream before the job is terminal', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(streamResponse(sse(job('running', 10))))
      .mockResolvedValueOnce(streamResponse(sse(job('running', 10), job('succeeded', 100))));
    const final = await watchJob('j', {
      signal: new AbortController().signal,
      fetchImpl,
      sleep: noSleep,
      onJob: () => undefined,
    });
    expect(final.status).toBe('succeeded');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledWith(10, expect.any(AbortSignal));
  });

  it('falls back to polling when the stream keeps failing', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/events')) throw new TypeError('network');
      return Response.json(job('succeeded', 100));
    });
    const final = await watchJob('j', {
      signal: new AbortController().signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      onJob: () => undefined,
      maxStreamFailures: 2,
    });
    expect(final.status).toBe('succeeded');
    expect(fetchImpl.mock.calls.map(([u]) => u)).toEqual([
      '/api/jobs/j/events',
      '/api/jobs/j/events',
      '/api/jobs/j',
    ]);
  });

  it('ends with JobGoneError when access ends, and with the API error when signed out', async () => {
    await expect(
      watchJob('j', {
        signal: new AbortController().signal,
        fetchImpl: (async () => streamResponse('event: gone\ndata: {}\n\n')) as typeof fetch,
        sleep: noSleep,
        onJob: () => undefined,
      }),
    ).rejects.toBeInstanceOf(JobGoneError);
    await expect(
      watchJob('j', {
        signal: new AbortController().signal,
        fetchImpl: (async () =>
          Response.json({ title: 'Unauthorized' }, { status: 401 })) as typeof fetch,
        sleep: noSleep,
        onJob: () => undefined,
      }),
    ).rejects.toSatisfy((e) => e instanceof DocumentApiError && e.kind === 'unauthenticated');
  });
});

// --- relay --------------------------------------------------------------------------------------

let token: string | null = 'header.payload.sig';
vi.mock('../src/lib/supabase/server', () => ({ createSupabaseServerClient: async () => ({}) }));
vi.mock('../src/lib/api/server', () => ({
  verifiedAccessToken: async () => token,
  bearerHeaders: (t: string) => ({ Authorization: `Bearer ${t}` }),
}));
vi.mock('../src/env', () => ({
  getPublicEnv: () => ({
    apiBaseUrl: 'http://127.0.0.1:8210',
    supabaseUrl: 'http://127.0.0.1:54321',
    supabasePublishableKey: 'pk',
  }),
}));

describe('relayToApi', () => {
  beforeEach(() => {
    token = 'header.payload.sig';
    vi.unstubAllGlobals();
  });

  it('forwards as the verified user with a Bearer header and passes the answer through', async () => {
    const { relayToApi } = await import('../src/lib/documents/bff');
    const upstream = vi.fn(async () =>
      Response.json({ type: 'urn:x', detail: 'Only PDF files' }, { status: 415 }),
    );
    vi.stubGlobal('fetch', upstream);
    const request = new Request('http://web/api', { method: 'POST', body: '{"filename":"a.txt"}' });
    const response = await relayToApi('/workspaces/w/documents/upload-intent', {
      method: 'POST',
      body: request,
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ detail: 'Only PDF files' });
    expect(response.headers.get('cache-control')).toMatch(/no-store/);
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8210/api/v1/workspaces/w/documents/upload-intent');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer header.payload.sig' });
    expect(init.body).toBe('{"filename":"a.txt"}');
  });

  it('answers 401 without a verified session and 400 for non-object bodies, never calling the API', async () => {
    const { relayToApi } = await import('../src/lib/documents/bff');
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    token = null;
    expect((await relayToApi('/jobs/x', { method: 'GET' })).status).toBe(401);
    token = 't';
    const bad = new Request('http://web/api', { method: 'POST', body: '[1]' });
    expect(
      (await relayToApi('/documents/complete-upload', { method: 'POST', body: bad })).status,
    ).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('streams event responses unbuffered', async () => {
    const { relayToApi } = await import('../src/lib/documents/bff');
    vi.stubGlobal('fetch', async () => streamResponse(sse(job('succeeded', 100))));
    const response = await relayToApi('/jobs/j/events', { method: 'GET', stream: true });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('cache-control')).toMatch(/no-transform/);
    expect(await response.text()).toContain('event: job');
  });

  it('validates ids', async () => {
    const { isUuid } = await import('../src/lib/documents/bff');
    expect(isUuid('00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isUuid('../../admin')).toBe(false);
  });
});
