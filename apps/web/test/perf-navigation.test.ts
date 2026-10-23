// PERF-1: server-side page loads avoid sequential API round trips (each one costs the full
// web → API → DB latency) and duplicate reads.
import { describe, expect, it, vi } from 'vitest';

const WS = '11111111-1111-4111-8111-111111111111';
const Q = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const REV = '44444444-4444-4444-8444-444444444444';

type Get = (path: string, init?: unknown) => Promise<{ data?: unknown; response: Response }>;

let fakeApi: { GET: Get };
vi.mock('../src/lib/api/server', () => ({
  createServerApiClient: async () => fakeApi,
  NotAuthenticatedError: class extends Error {},
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));

const ok = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) });

describe('PERF-1 page loaders', () => {
  it('QGEN-01 loads the source question and its run history in parallel', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fakeApi = {
      GET: async (path) => {
        started.push(path);
        if (started.length === 2) release();
        await gate; // resolves only once both first-stage calls are in flight
        if (path === '/api/v1/questions/{question_id}') {
          return ok({ id: Q, workspace_id: WS, revision: { id: REV } });
        }
        if (path === '/api/v1/workspaces/{workspace_id}/question-generations') {
          return ok({ items: [{ id: RUN, source_question_revision_id: REV }] });
        }
        return ok({ items: [] });
      },
    };
    const { loadGenerationScreen } = await import('../src/lib/questions/generation-data');
    const data = await loadGenerationScreen(WS, Q, null);
    expect(started.slice(0, 2).sort()).toEqual([
      '/api/v1/questions/{question_id}',
      '/api/v1/workspaces/{workspace_id}/question-generations',
    ]);
    expect(started[2]).toBe('/api/v1/question-generations/{generation_id}/drafts');
    expect(data).toMatchObject({ kind: 'source', run: { id: RUN }, loadFailed: false });
  });

  it('QGEN-01 ignores the run history of a question from another workspace', async () => {
    fakeApi = {
      GET: async (path) => {
        if (path === '/api/v1/questions/{question_id}') {
          return ok({ id: Q, workspace_id: '55555555-5555-4555-8555-555555555555' });
        }
        if (path === '/api/v1/workspaces/{workspace_id}/question-generations') {
          return ok({ items: [{ id: RUN, source_question_revision_id: REV }] });
        }
        return ok({ items: [] });
      },
    };
    const { loadGenerationScreen } = await import('../src/lib/questions/generation-data');
    expect(await loadGenerationScreen(WS, Q, null)).toMatchObject({
      kind: 'pick',
      sourceMissing: true,
    });
  });

  it('QBANK-01 chapter context reuses the unfiltered document list (books that are ready)', async () => {
    const calls: { path: string; init: unknown }[] = [];
    fakeApi = {
      GET: async (path, init) => {
        calls.push({ path, init });
        if (path === '/api/v1/workspaces/{workspace_id}/documents') {
          return ok({
            items: [
              {
                id: 'b1',
                title: 'Book',
                filename: 'b.pdf',
                document_type: 'book',
                status: 'ready',
              },
              { id: 'b2', title: '', filename: 'p.pdf', document_type: 'book', status: 'parsing' },
              {
                id: 'p1',
                title: 'Paper',
                filename: 'q.pdf',
                document_type: 'question_paper',
                status: 'ready',
              },
            ],
          });
        }
        return ok({ items: [{ id: 'c1', title: ' Ch 1 ', level: 1 }] });
      },
    };
    const { loadChapterContext } = await import('../src/lib/questions/server');
    const context = await loadChapterContext(fakeApi as never, WS);
    expect(calls[0]).toEqual({
      path: '/api/v1/workspaces/{workspace_id}/documents',
      init: { params: { path: { workspace_id: WS } } },
    });
    expect(context.documents).toEqual([{ id: 'b1', title: 'Book' }]);
    expect(context.chapters).toEqual([
      { id: 'c1', title: 'Ch 1', level: 1, documentId: 'b1', documentTitle: 'Book' },
    ]);
    expect(calls).toHaveLength(2);
  });
});
