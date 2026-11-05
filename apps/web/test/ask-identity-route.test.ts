import { beforeEach, describe, expect, it, vi } from 'vitest';

const getClaims = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({ auth: { getClaims } }),
}));
import { GET } from '../src/app/api/auth/identity/route';

describe('verified identity endpoint', () => {
  beforeEach(() => getClaims.mockReset());
  it('returns only verified claims and disables caching', async () => {
    getClaims.mockResolvedValue({
      data: { claims: { sub: 'verified', email: 'private@example.test' } },
      error: null,
    });
    const response = await GET();
    expect(await response.json()).toEqual({ id: 'verified' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('distinguishes a missing session from a verification outage', async () => {
    getClaims.mockResolvedValueOnce({ data: null, error: { name: 'AuthSessionMissingError' } });
    expect(await (await GET()).json()).toEqual({ id: null });
    getClaims.mockResolvedValueOnce({ data: null, error: { name: 'AuthRetryableFetchError' } });
    expect((await GET()).status).toBe(503);
    getClaims.mockResolvedValueOnce({ data: null, error: null });
    expect(await (await GET()).json()).toEqual({ id: null });
    getClaims.mockResolvedValueOnce({ data: { claims: {} }, error: null });
    expect((await GET()).status).toBe(503);
    getClaims.mockRejectedValueOnce(new Error('offline'));
    expect((await GET()).status).toBe(503);
  });
});
