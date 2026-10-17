// WS-SHARE-01 server actions with a mocked API client: revoke turns off every given link (no count
// cap, duplicates once), and the refreshed list comes back.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { method: string; path: string; params: unknown }[] = [];
const api = {
  GET: vi.fn(async (path: string, init: { params: unknown }) => {
    calls.push({ method: 'GET', path, params: init.params });
    return { data: { items: [] }, response: new Response(null, { status: 200 }) };
  }),
  POST: vi.fn(async (path: string, init: { params: unknown }) => {
    calls.push({ method: 'POST', path, params: init.params });
    return { data: {}, response: new Response(null, { status: 200 }) };
  }),
};

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('../src/lib/api/server', () => ({
  createServerApiClient: async () => api,
  NotAuthenticatedError: class NotAuthenticatedError extends Error {},
}));

const { revokeShareLinksAction } = await import('../src/lib/sharing/actions');

const WS = '3f2b6f0e-8a4c-4d7e-9a51-1c2d3e4f5a6b';
const ids = Array.from(
  { length: 25 },
  (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
);

beforeEach(() => {
  calls.length = 0;
});

describe('revokeShareLinksAction', () => {
  it('revokes every link, however many, each once', async () => {
    const result = await revokeShareLinksAction(WS, [...ids, ids[0] ?? '']);
    expect(result).toEqual({ ok: true, links: [] });
    const revoked = calls.filter((c) => c.method === 'POST');
    expect(revoked).toHaveLength(25);
    expect(revoked.every((c) => c.path.endsWith('/share-links/{link_id}/revoke'))).toBe(true);
    expect(revoked.map((c) => (c.params as { path: { link_id: string } }).path.link_id)).toEqual(
      ids,
    );
  });

  it('rejects an empty list and malformed ids before calling the API', async () => {
    expect(await revokeShareLinksAction(WS, [])).toMatchObject({ ok: false, failure: 'invalid' });
    expect(await revokeShareLinksAction(WS, ['nope'])).toMatchObject({
      ok: false,
      failure: 'notFound',
    });
    expect(calls).toEqual([]);
  });
});
