// PERF-1: server-side page loads avoid sequential API round trips (each one costs the full
// web → API → DB latency) and duplicate reads.
import { describe, expect, it, vi } from 'vitest';

const WS = '11111111-1111-4111-8111-111111111111';

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
  it('the question editor context reuses the unfiltered document list (books that are ready)', async () => {
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
