// DOC-01 (M3.3): client-side file checks, SHA-256 hashing (worker + fallback), the upload state
// machine (resume/retry without a second document, cancel) and the list row merge.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  DocumentsClient,
  DocumentSummary,
  Job,
  UploadIntent,
} from '../src/lib/documents/client-api';
import { DocumentApiError, classifyDocumentFailure } from '../src/lib/documents/errors';
import { digestBlob, toHex } from '../src/lib/documents/sha256-core';
import { HashAbortedError, hashFile, type WorkerLike } from '../src/lib/documents/sha256';
import { UploadAbortedError, type Transfer } from '../src/lib/documents/transport';
import {
  buildRows,
  isCancellable,
  newUploadItem,
  resumePhase,
  runUpload,
  uploadsReducer,
  type UploadAction,
  type UploadContext,
  type UploadDeps,
  type UploadItem,
} from '../src/lib/documents/upload-machine';
import {
  FILE_REJECTION_MESSAGES,
  MAX_UPLOAD_BYTES,
  defaultTitle,
  formatBytes,
  validatePdfFile,
} from '../src/lib/documents/validation';

const PDF = 'application/pdf';

describe('validatePdfFile (DOC-01-AC03)', () => {
  it('accepts a PDF up to 50 MiB', () => {
    expect(validatePdfFile({ name: 'book.pdf', size: 1, type: PDF })).toEqual({ ok: true });
    expect(validatePdfFile({ name: 'BOOK.PDF', size: MAX_UPLOAD_BYTES, type: '' })).toEqual({
      ok: true,
    });
  });

  it('rejects other types by name or browser type, with the reason', () => {
    expect(validatePdfFile({ name: 'notes.txt', size: 9, type: 'text/plain' })).toMatchObject({
      ok: false,
      reason: 'type',
      message: FILE_REJECTION_MESSAGES.type,
    });
    expect(validatePdfFile({ name: 'fake.pdf', size: 9, type: 'text/plain' })).toMatchObject({
      reason: 'type',
    });
    expect(validatePdfFile({ name: 'doc.pdf.exe', size: 9, type: '' })).toMatchObject({
      reason: 'type',
    });
    expect(FILE_REJECTION_MESSAGES.type).toMatch(/pdf/i);
  });

  it('rejects files over 50 MiB and empty files', () => {
    expect(
      validatePdfFile({ name: 'big.pdf', size: MAX_UPLOAD_BYTES + 1, type: PDF }),
    ).toMatchObject({ reason: 'size', message: expect.stringMatching(/50\s?MB/) });
    expect(validatePdfFile({ name: 'empty.pdf', size: 0, type: PDF })).toMatchObject({
      reason: 'empty',
    });
  });

  it('derives the API default title and human sizes', () => {
    expect(defaultTitle('book-ko.pdf')).toBe('book-ko');
    expect(defaultTitle('  my   book.pdf')).toBe('my book');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50.0 MB');
  });
});

describe('classifyDocumentFailure', () => {
  const problem = (type: string) => ({ type, title: 't', status: 409 });
  it('maps statuses and problem types', () => {
    expect(classifyDocumentFailure(401, undefined)).toBe('unauthenticated');
    expect(
      classifyDocumentFailure(403, problem('urn:quiz-workspace:problem:workspace-archived')),
    ).toBe('archived');
    expect(classifyDocumentFailure(403, undefined)).toBe('forbidden');
    expect(
      classifyDocumentFailure(409, problem('urn:quiz-workspace:problem:upload-incomplete')),
    ).toBe('incomplete');
    expect(classifyDocumentFailure(409, problem('urn:quiz-workspace:problem:upload-expired'))).toBe(
      'expired',
    );
    expect(
      classifyDocumentFailure(422, problem('urn:quiz-workspace:problem:upload-mismatch')),
    ).toBe('mismatch');
    expect(classifyDocumentFailure(413, undefined)).toBe('tooLarge');
    expect(classifyDocumentFailure(415, undefined)).toBe('rejected');
    expect(classifyDocumentFailure(502, undefined)).toBe('unavailable');
  });

  it('marks only transient failures retryable', () => {
    expect(new DocumentApiError('network').retryable).toBe(true);
    expect(new DocumentApiError('expired').retryable).toBe(true);
    expect(new DocumentApiError('mismatch').retryable).toBe(false);
    expect(new DocumentApiError('forbidden').retryable).toBe(false);
  });
});

describe('hashFile', () => {
  const bytes = new TextEncoder().encode('%PDF-1.7 synthetic');
  const expected = createHash('sha256').update(bytes).digest('hex');

  it('digests like node:crypto', async () => {
    expect(await digestBlob(new Blob([bytes]))).toBe(expected);
    expect(toHex(new Uint8Array([0, 15, 255]).buffer)).toBe('000fff');
  });

  function fakeWorker(
    behaviour: 'reply' | 'error' | 'silent',
  ): WorkerLike & { terminated: boolean } {
    const worker = {
      onmessage: null as WorkerLike['onmessage'],
      onerror: null as WorkerLike['onerror'],
      terminated: false,
      terminate() {
        worker.terminated = true;
      },
      postMessage({ id, blob }: { id: number; blob: Blob }) {
        if (behaviour === 'silent') return;
        if (behaviour === 'error') {
          queueMicrotask(() => worker.onerror?.(new Event('error')));
          return;
        }
        void digestBlob(blob).then((hex) =>
          worker.onmessage?.({ data: { id, hex } } as MessageEvent),
        );
      },
    };
    return worker;
  }

  it('hashes in the worker and terminates it', async () => {
    const worker = fakeWorker('reply');
    expect(await hashFile(new Blob([bytes]), undefined, () => worker)).toBe(expected);
    expect(worker.terminated).toBe(true);
  });

  it('falls back to the main thread when the worker fails or cannot start', async () => {
    expect(await hashFile(new Blob([bytes]), undefined, () => fakeWorker('error'))).toBe(expected);
    expect(await hashFile(new Blob([bytes]), undefined, () => null)).toBe(expected);
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    const worker = fakeWorker('silent');
    const pending = hashFile(new Blob([bytes]), controller.signal, () => worker);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(HashAbortedError);
    expect(worker.terminated).toBe(true);
  });
});

// --- state machine ------------------------------------------------------------------------------

const WS = '00000000-0000-4000-8000-000000000001';
const SHA = 'a'.repeat(64);

function intent(n: number, expiresInMs = 600_000): UploadIntent {
  return {
    upload_id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
    upload_url: `http://127.0.0.1:54321/storage/v1/object/upload/sign/k${n}?token=secret`,
    upload_method: 'PUT',
    upload_headers: { 'content-type': PDF },
    resumable: { endpoint: 'http://x/resumable', headers: { 'x-signature': 's' }, metadata: {} },
    expires_at: new Date(Date.now() + expiresInMs).toISOString(),
    max_size_bytes: MAX_UPLOAD_BYTES,
  };
}

function job(status: Job['status'], extra: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    job_type: 'document.parse',
    status,
    progress: status === 'succeeded' ? 100 : null,
    stage: null,
    error_code: null,
    attempts: 1,
    max_attempts: 3,
    cancel_requested: false,
    created_at: '2026-10-17T00:00:00Z',
    updated_at: '2026-10-17T00:00:00Z',
    started_at: null,
    finished_at: null,
    ...extra,
  };
}

interface Harness {
  deps: UploadDeps;
  client: { [K in keyof DocumentsClient]: ReturnType<typeof vi.fn> };
  transfers: Transfer[];
  transferRuns: ReturnType<typeof vi.fn>;
}

function harness(transferBehaviour: ('ok' | 'network' | 'hang')[]): Harness {
  let intents = 0;
  const client = {
    createUploadIntent: vi.fn(async () => intent(++intents)),
    completeUpload: vi.fn(async () => ({ document_id: 'doc-1', job_id: 'job-1' })),
    listDocuments: vi.fn(async () => []),
    deleteDocument: vi.fn(async () => undefined),
    updateDocumentKind: vi.fn(async () => {
      throw new Error('not used by uploads');
    }),
    getJob: vi.fn(async () => job('succeeded')),
  };
  const transfers: Transfer[] = [];
  const transferRuns = vi.fn();
  const deps: UploadDeps = {
    client,
    hash: vi.fn(async () => SHA),
    createTransfer: (_file, _intent) => {
      const transfer: Transfer = {
        resumable: false,
        run: async ({ onProgress, signal }) => {
          transferRuns(_intent.upload_id);
          const next = transferBehaviour.shift() ?? 'ok';
          if (next === 'network') throw new DocumentApiError('network');
          if (next === 'hang') {
            await new Promise((_, reject) =>
              signal.addEventListener('abort', () => reject(new UploadAbortedError())),
            );
          }
          onProgress(5, 10);
          onProgress(10, 10);
        },
      };
      transfers.push(transfer);
      return transfer;
    },
    watchJob: vi.fn(async (_jobId, { onJob }) => {
      onJob(job('queued'));
      onJob(job('running', { stage: 'indexing', progress: 60 }));
      const done = job('succeeded');
      onJob(done);
      return done;
    }),
  };
  return { deps, client, transfers, transferRuns };
}

async function drive(
  h: Harness,
  item: UploadItem,
  context: UploadContext,
  state: UploadItem[],
  signal = new AbortController().signal,
): Promise<UploadItem[]> {
  let current = state;
  const actions: UploadAction[] = [];
  await runUpload({
    workspaceId: WS,
    item,
    file: new Blob(['%PDF-']),
    context,
    deps: h.deps,
    signal,
    dispatch: (action) => {
      actions.push(action);
      current = uploadsReducer(current, action);
    },
  });
  return current;
}

function only(state: readonly UploadItem[]): UploadItem {
  const [item] = state;
  if (!item) throw new Error('no upload item');
  return item;
}

describe('upload state machine', () => {
  const fresh = () => newUploadItem('local-1', { name: 'book-ko.pdf', size: 10 }, 'book-ko');

  it('runs hash → intent (`auto`, UX6-UPLOAD) → upload → complete → job to READY (DOC-01-AC02)', async () => {
    const h = harness(['ok']);
    const item = fresh();
    const state = await drive(h, item, {}, [item]);
    expect(state[0]).toMatchObject({
      phase: 'ready',
      sha256: SHA,
      stored: true,
      documentId: 'doc-1',
      jobId: 'job-1',
      job: { status: 'succeeded', progress: 100 },
    });
    expect(h.client.createUploadIntent).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({
        filename: 'book-ko.pdf',
        size_bytes: 10,
        sha256: SHA,
        content_type: PDF,
        document_type: 'auto',
      }),
      expect.any(AbortSignal),
    );
    expect(h.client.completeUpload).toHaveBeenCalledTimes(1);
  });

  it('retries an interrupted upload with the same intent and creates one document (DOC-01-AC04)', async () => {
    const h = harness(['network', 'ok']);
    const context: UploadContext = {};
    const item = fresh();
    let state = await drive(h, item, context, [item]);
    expect(state[0]).toMatchObject({
      phase: 'failed',
      failedIn: 'uploading',
      failure: { kind: 'network', retryable: true },
    });
    expect(isCancellable(only(state))).toBe(true);
    expect(h.client.completeUpload).not.toHaveBeenCalled();
    expect(resumePhase(only(state))).toBe('uploading');

    state = uploadsReducer(state, { type: 'retry', localId: 'local-1' });
    state = await drive(h, only(state), context, state);
    expect(state[0]).toMatchObject({ phase: 'ready', documentId: 'doc-1' });
    expect(h.client.createUploadIntent).toHaveBeenCalledTimes(1);
    const uploadIds = h.transferRuns.mock.calls.map(([id]) => id as string);
    expect(uploadIds).toHaveLength(2);
    expect(new Set(uploadIds).size).toBe(1);
    // The same transfer object is resumed (TUS keeps its offset in it).
    expect(h.transfers).toHaveLength(1);
    expect(h.client.completeUpload).toHaveBeenCalledTimes(1);
    // The signed URL is dropped once the document exists.
    expect(context.intent).toBeUndefined();
  });

  it('requests a new intent when the old one expired', async () => {
    const h = harness(['ok']);
    h.client.completeUpload
      .mockRejectedValueOnce(new DocumentApiError('expired', 409))
      .mockResolvedValueOnce({ document_id: 'doc-1', job_id: 'job-1' });
    const context: UploadContext = {};
    const item = fresh();
    let state = await drive(h, item, context, [item]);
    expect(state[0]).toMatchObject({ phase: 'failed', failure: { kind: 'expired' } });
    expect(state[0]?.uploadId).toBeUndefined();
    expect(resumePhase(only(state))).toBe('requesting');

    state = uploadsReducer(state, { type: 'retry', localId: 'local-1' });
    state = await drive(h, only(state), context, state);
    expect(state[0]?.phase).toBe('ready');
    expect(h.client.createUploadIntent).toHaveBeenCalledTimes(2);
  });

  it('re-sends the bytes when complete-upload reports them missing', async () => {
    const h = harness(['ok', 'ok']);
    h.client.completeUpload
      .mockRejectedValueOnce(new DocumentApiError('incomplete', 409))
      .mockResolvedValueOnce({ document_id: 'doc-1', job_id: 'job-1' });
    const context: UploadContext = {};
    const item = fresh();
    let state = await drive(h, item, context, [item]);
    expect(state[0]).toMatchObject({ stored: false, failure: { kind: 'incomplete' } });
    state = uploadsReducer(state, { type: 'retry', localId: 'local-1' });
    state = await drive(h, only(state), context, state);
    expect(state[0]?.phase).toBe('ready');
    expect(h.transferRuns).toHaveBeenCalledTimes(2);
    expect(h.client.createUploadIntent).toHaveBeenCalledTimes(1);
  });

  it('replays complete-upload with the original intent after a lost response, even past its expiry', async () => {
    const h = harness(['ok']);
    // The first completion commits server-side but its response is lost.
    h.client.completeUpload
      .mockRejectedValueOnce(new DocumentApiError('network'))
      .mockResolvedValueOnce({ document_id: 'doc-1', job_id: 'job-1' });
    const context: UploadContext = {};
    const item = fresh();
    let state = await drive(h, item, context, [item]);
    expect(only(state)).toMatchObject({ stored: true, failure: { kind: 'network' } });
    const firstUploadId = only(state).uploadId;

    // By the time the user retries, the intent has expired on the client clock.
    state = state.map((i) => ({ ...i, intentExpiresAt: Date.now() - 1 }));
    expect(resumePhase(only(state))).toBe('completing');
    state = uploadsReducer(state, { type: 'retry', localId: 'local-1' });
    state = await drive(h, only(state), context, state);

    expect(only(state)).toMatchObject({ phase: 'ready', documentId: 'doc-1' });
    expect(h.client.createUploadIntent).toHaveBeenCalledTimes(1);
    expect(h.transferRuns).toHaveBeenCalledTimes(1);
    expect(h.client.completeUpload.mock.calls.map(([id]) => id as string)).toEqual([
      firstUploadId,
      firstUploadId,
    ]);
  });

  it('does not offer retry for a mismatched upload or a failed job', async () => {
    const h = harness(['ok']);
    h.client.completeUpload.mockRejectedValueOnce(new DocumentApiError('mismatch', 422));
    const item = fresh();
    let state = await drive(h, item, {}, [item]);
    expect(state[0]?.failure).toMatchObject({ kind: 'mismatch', retryable: false });
    expect(uploadsReducer(state, { type: 'retry', localId: 'local-1' })).toEqual(state);

    const h2 = harness(['ok']);
    h2.deps = {
      ...h2.deps,
      watchJob: async (_id, { onJob }) => {
        const failed = job('failed', { error_code: 'parse_failed' });
        onJob(failed);
        return failed;
      },
    };
    state = await drive(h2, item, {}, [item]);
    expect(state[0]).toMatchObject({
      phase: 'failed',
      failedIn: 'processing',
      failure: { kind: 'job', retryable: false, message: expect.stringContaining('parse_failed') },
    });
    expect(isCancellable(only(state))).toBe(false);
  });

  it('cancelling stops the transfer without a failure and never completes (DOC-01-AC04)', async () => {
    const h = harness(['hang']);
    const controller = new AbortController();
    const item = fresh();
    const running = drive(h, item, {}, [item], controller.signal);
    await vi.waitFor(() => expect(h.transferRuns).toHaveBeenCalled());
    controller.abort();
    const state = await running;
    expect(state[0]?.phase).toBe('uploading');
    expect(state[0]?.failure).toBeUndefined();
    expect(h.client.completeUpload).not.toHaveBeenCalled();
  });
});

describe('buildRows', () => {
  const doc = (
    id: string,
    status: DocumentSummary['status'],
    extra: Partial<DocumentSummary> = {},
  ) =>
    ({
      id,
      workspace_id: WS,
      document_type: 'book',
      title: `title-${id}`,
      filename: `${id}.pdf`,
      size_bytes: 100,
      sha256: SHA,
      status,
      active_revision_id: null,
      last_error: null,
      created_at: '2026-10-17T00:00:00Z',
      updated_at: '2026-10-17T00:00:00Z',
      ...extra,
    }) satisfies DocumentSummary;

  const base = newUploadItem('l1', { name: 'new.pdf', size: 10 }, 'new');

  it('shows local uploads first, then server documents, one row per document', () => {
    const uploading = { ...base, phase: 'uploading' as const, loaded: 5 };
    const rows = buildRows([doc('d1', 'ready')], [uploading]);
    expect(rows.map((r) => [r.key, r.status])).toEqual([
      ['local-l1', 'uploading'],
      ['d1', 'ready'],
    ]);
    expect(rows[0]?.upload).toEqual({ phase: 'uploading', loaded: 5, total: 10 });
    expect(rows[0]?.cancellable).toBe(true);
  });

  it('merges a completed upload with its listed document and prefers terminal states', () => {
    const processing: UploadItem = {
      ...base,
      phase: 'processing',
      documentId: 'd2',
      jobId: 'j',
      stored: true,
      job: {
        status: 'running',
        stage: 'indexing',
        progress: 60,
        errorCode: null,
        queuedAt: null,
        startedAt: null,
      },
    };
    let rows = buildRows([doc('d2', 'processing')], [processing]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'd2', status: 'processing', job: { progress: 60 } });

    rows = buildRows([doc('d2', 'ready')], [processing]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ready');

    rows = buildRows([doc('d2', 'processing')], [{ ...processing, phase: 'ready' }]);
    expect(rows[0]?.status).toBe('ready');
  });

  it('shows the failure reason of a failed document', () => {
    const rows = buildRows([doc('d3', 'failed', { last_error: 'parse_failed' })], []);
    expect(rows[0]).toMatchObject({ status: 'failed', retryable: false });
    expect(rows[0]?.error).toContain('parse_failed');
  });

  it('carries the kind: unknown for an auto upload until the server classified it (UX6-UPLOAD)', () => {
    const uploading = { ...base, phase: 'uploading' as const };
    expect(buildRows([], [uploading])[0]?.kind).toBeNull();
    const chosen = newUploadItem('l2', { name: 'q.pdf', size: 10 }, 'q', 'question_paper');
    expect(buildRows([], [chosen])[0]?.kind).toBe('question_paper');
    const listed = (kind: DocumentSummary['kind']) =>
      buildRows([doc('d4', 'ready', { kind, document_type: 'book' })], [])[0]?.kind;
    expect(listed('mixed')).toBe('mixed');
    expect(listed(null)).toBeNull();
    // A document from before UX6-UPLOAD-B (no `kind` in the list) shows its type.
    expect(listed(undefined)).toBe('book');
  });
});
