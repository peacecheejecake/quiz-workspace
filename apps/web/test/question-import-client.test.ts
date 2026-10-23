// QIMPORT-01 browser client: problem classification and the requests it sends to the same-origin
// relays (Idempotency-Key on start/retry, approve-then-publish body, a lost response = network).
import { describe, expect, it, vi } from 'vitest';
import {
  classifyImportFailure,
  createImportClient,
  IMPORT_BFF_PATHS,
  IMPORT_PROBLEMS,
  ImportApiError,
  importPath,
} from '../src/lib/questions/import-client';

const WS = '55555555-5555-4555-8555-555555555555';
const RUN = '22222222-2222-4222-8222-222222222222';
const DRAFT = '11111111-1111-4111-8111-111111111111';

function firstCall(fn: { mock: { calls: Parameters<typeof fetch>[] } }): Parameters<typeof fetch> {
  const call = fn.mock.calls[0];
  if (!call) throw new Error('fetch was not called');
  return call;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('classifyImportFailure', () => {
  it.each([
    [401, undefined, 'unauthenticated'],
    [403, { type: IMPORT_PROBLEMS.workspaceArchived }, 'archived'],
    [403, { type: 'urn:quiz-workspace:problem:insufficient-role' }, 'forbidden'],
    [404, undefined, 'notFound'],
    [409, { type: IMPORT_PROBLEMS.staleDraft }, 'staleDraft'],
    [409, { type: IMPORT_PROBLEMS.draftPublished }, 'draftPublished'],
    [409, { type: IMPORT_PROBLEMS.draftNotApproved }, 'draftNotApproved'],
    [409, { type: IMPORT_PROBLEMS.importNotRetryable }, 'notRetryable'],
    [409, { type: IMPORT_PROBLEMS.documentNotReady }, 'documentNotReady'],
    [409, { type: IMPORT_PROBLEMS.idempotencyKeyReused }, 'idempotencyKeyReused'],
    [409, { type: IMPORT_PROBLEMS.registrationRunning }, 'registrationRunning'],
    [409, { type: 'urn:other' }, 'unavailable'],
    [422, { errors: [] }, 'invalid'],
    [503, undefined, 'unavailable'],
  ] as const)('%i %j → %s', (status, body, kind) => {
    expect(classifyImportFailure(status, body)).toBe(kind);
  });
});

describe('createImportClient', () => {
  it('starts an import with the Idempotency-Key and the document id only', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(202, { id: RUN }));
    await createImportClient(fetchImpl).startImport(WS, 'doc-1', 'key-1');
    const [path, init] = firstCall(fetchImpl);
    expect(path).toBe(IMPORT_BFF_PATHS.imports(WS));
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ document_id: 'doc-1' });
    expect((init?.headers as Record<string, string>)['idempotency-key']).toBe('key-1');
    expect(init?.credentials).toBe('same-origin');
  });

  it('retries a run with its own key and no body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(202, { id: RUN }));
    await createImportClient(fetchImpl).retryImport(RUN, 'retry-key');
    const [path, init] = firstCall(fetchImpl);
    expect(path).toBe(IMPORT_BFF_PATHS.retry(RUN));
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Record<string, string>)['idempotency-key']).toBe('retry-key');
  });

  it('publishes the reviewed drafts with their versions and returns the mapping', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json(200, { items: [{ draft_id: DRAFT, question_id: 'q1' }] }),
    );
    const items = await createImportClient(fetchImpl).publish(RUN, [
      { draft_id: DRAFT, version: 'v7' },
    ]);
    expect(items).toEqual([{ draft_id: DRAFT, question_id: 'q1' }]);
    const [path, init] = firstCall(fetchImpl);
    expect(path).toBe(IMPORT_BFF_PATHS.publish(RUN));
    expect(JSON.parse(String(init?.body))).toEqual({
      drafts: [{ draft_id: DRAFT, version: 'v7' }],
    });
  });

  it('QIMP-JOB: submits the whole selection with its key and reads the progress', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(202, { job_id: 'job-1' }));
    const client = createImportClient(fetchImpl);
    await client.register(RUN, [{ draft_id: DRAFT, version: 'v7' }], 'reg-key');
    const [path, init] = firstCall(fetchImpl);
    expect(path).toBe(IMPORT_BFF_PATHS.registrations(RUN));
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      drafts: [{ draft_id: DRAFT, version: 'v7' }],
    });
    expect((init?.headers as Record<string, string>)['idempotency-key']).toBe('reg-key');
    await client.getRegistration(RUN, 'job-1');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(IMPORT_BFF_PATHS.registration(RUN, 'job-1'));
  });

  it('patches a draft at its base version', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, { id: DRAFT }));
    await createImportClient(fetchImpl).updateDraft(DRAFT, {
      base_version: 'v1',
      review_status: 'approved',
    });
    const [path, init] = firstCall(fetchImpl);
    expect(path).toBe(IMPORT_BFF_PATHS.draft(DRAFT));
    expect(init?.method).toBe('PATCH');
  });

  it('turns a dropped request or an unreadable success into a network failure', async () => {
    const dropped = createImportClient(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(dropped.listDrafts(RUN)).rejects.toMatchObject({ kind: 'network' });
    const truncated = createImportClient(async () => new Response('{"items": [', { status: 200 }));
    await expect(truncated.listDrafts(RUN)).rejects.toMatchObject({ kind: 'network' });
  });

  it('classifies problem responses', async () => {
    const client = createImportClient(async () =>
      json(409, { type: IMPORT_PROBLEMS.staleDraft, status: 409 }),
    );
    const error = await client.updateDraft(DRAFT, { base_version: 'old' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportApiError);
    expect(error).toMatchObject({ kind: 'staleDraft', status: 409 });
    expect((error as Error).message).toMatch(/[가-힣]/);
  });

  it('reads the newest run of the workspace (null when there is none)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, { items: [{ id: RUN }] }));
    await expect(createImportClient(fetchImpl).latestRun(WS)).resolves.toEqual({ id: RUN });
    expect(firstCall(fetchImpl)[0]).toBe(`${IMPORT_BFF_PATHS.imports(WS)}?limit=1`);
    const empty = createImportClient(async () => json(200, { items: [] }));
    await expect(empty.latestRun(WS)).resolves.toBeNull();
  });

  it('rethrows an abort as is', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createImportClient(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(client.getRun(RUN, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('QIMPORT-01-AC06 attaching to the server-started import', () => {
  const DOC = '33333333-3333-4333-8333-333333333333';

  it('opens the import page of one question paper', () => {
    expect(importPath(WS)).toBe(`/workspaces/${WS}/questions/import`);
    expect(importPath(WS, DOC)).toBe(`/workspaces/${WS}/questions/import?document=${DOC}`);
  });

  it('reads the newest run of one paper through the relay', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, { items: [{ id: RUN }] }));
    expect(await createImportClient(fetchImpl).latestRun(WS, undefined, DOC)).toEqual({ id: RUN });
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      `${IMPORT_BFF_PATHS.imports(WS)}?limit=1&document_id=${DOC}`,
    ]);
  });
});
