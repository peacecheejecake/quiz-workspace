// Route handler + proxy wiring with a mocked @supabase/ssr client: which Supabase call runs, where
// the response redirects, that refreshed cookies travel with redirects, and that tokens never
// reach a Location header.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CookieWrite {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

const auth = {
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  getClaims: vi.fn(),
};
let cookieWrites: CookieWrite[] = [];

vi.mock('@supabase/ssr', () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: { cookies: { setAll: (c: CookieWrite[], h: Record<string, string>) => void } },
  ) => {
    const flush = () => {
      if (cookieWrites.length) {
        options.cookies.setAll(cookieWrites, { 'Cache-Control': 'private, no-store' });
      }
    };
    return {
      auth: {
        verifyOtp: async (...args: unknown[]) => {
          const result = (await auth.verifyOtp(...args)) as { error: unknown };
          if (!result.error) flush();
          return result;
        },
        exchangeCodeForSession: async (...args: unknown[]) => {
          const result = (await auth.exchangeCodeForSession(...args)) as { error: unknown };
          if (!result.error) flush();
          return result;
        },
        getClaims: async () => {
          flush();
          return auth.getClaims() as unknown;
        },
      },
    };
  },
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
process.env.NEXT_PUBLIC_API_BASE_URL = 'http://127.0.0.1:8000';

const { GET } = await import('../src/app/auth/callback/route');
const { updateSession } = await import('../src/lib/supabase/proxy');

const ORIGIN = 'http://127.0.0.1:3000';
const request = (path: string) => new NextRequest(new URL(path, ORIGIN));
const location = (res: Response) => new URL(res.headers.get('location') ?? '', ORIGIN);

beforeEach(() => {
  vi.clearAllMocks();
  cookieWrites = [];
});

describe('GET /auth/callback', () => {
  it('verifies a token_hash, sets the session cookie and redirects to the validated next', async () => {
    auth.verifyOtp.mockResolvedValue({ error: null });
    cookieWrites = [{ name: 'sb-127-auth-token', value: 'session', options: { path: '/' } }];

    const res = await GET(
      request('/auth/callback?token_hash=h1&type=email&next=/settings/security'),
    );

    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'h1', type: 'email' });
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(res.status).toBe(303);
    expect(location(res).pathname).toBe('/settings/security');
    expect(location(res).origin).toBe(ORIGIN);
    expect(res.headers.get('set-cookie')).toContain('sb-127-auth-token=session');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('exchanges a code and ignores an external next', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ error: null });
    const res = await GET(request('/auth/callback?code=c1&next=https://evil.example/x'));
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith('c1');
    expect(location(res).origin).toBe(ORIGIN);
    expect(location(res).pathname).toBe('/workspaces');
  });

  it('sends recovery links to /reset-password', async () => {
    auth.verifyOtp.mockResolvedValue({ error: null });
    const res = await GET(request('/auth/callback?token_hash=h2&type=recovery&next=/workspaces'));
    expect(location(res).pathname).toBe('/reset-password');
  });

  it('redirects failures to /auth/error with a reason code and no token or cookie', async () => {
    auth.verifyOtp.mockResolvedValue({ error: { code: 'otp_expired', status: 403 } });
    const res = await GET(request('/auth/callback?token_hash=secret-hash&type=signup'));
    const loc = location(res);
    expect(loc.pathname).toBe('/auth/error');
    expect(loc.searchParams.get('reason')).toBe('expired');
    expect(loc.searchParams.get('flow')).toBe('signup');
    expect(res.headers.get('location')).not.toContain('secret-hash');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('never calls Supabase when the link has no code', async () => {
    const res = await GET(request('/auth/callback'));
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(location(res).searchParams.get('reason')).toBe('missing');
  });
});

describe('proxy updateSession', () => {
  it('redirects signed-out protected requests to /login?next=<path+query>', async () => {
    auth.getClaims.mockResolvedValue({ data: null, error: null });
    const res = await updateSession(request('/workspaces/ws/documents?tab=all'));
    expect(res.status).toBe(307);
    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('next')).toBe('/workspaces/ws/documents?tab=all');
  });

  it('treats a claims verification error as signed out', async () => {
    auth.getClaims.mockResolvedValue({ data: null, error: { message: 'invalid JWT' } });
    const res = await updateSession(request('/settings/security'));
    expect(location(res).pathname).toBe('/login');
  });

  it('passes verified sessions through and forwards refreshed cookies', async () => {
    auth.getClaims.mockResolvedValue({ data: { claims: { sub: 'user-1' } }, error: null });
    cookieWrites = [{ name: 'sb-127-auth-token', value: 'refreshed', options: { path: '/' } }];
    const res = await updateSession(request('/workspaces'));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('set-cookie')).toContain('sb-127-auth-token=refreshed');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('bounces signed-in users from /login to the validated next, keeping refreshed cookies', async () => {
    auth.getClaims.mockResolvedValue({ data: { claims: { sub: 'user-1' } }, error: null });
    cookieWrites = [{ name: 'sb-127-auth-token', value: 'refreshed', options: { path: '/' } }];
    const res = await updateSession(request('/login?next=%2F%2Fevil.example'));
    // NextRequest reports 127.0.0.1 as localhost; Next's proxy adapter relativizes the Location.
    expect(location(res).host).toMatch(/^(127\.0\.0\.1|localhost):3000$/);
    expect(location(res).pathname).toBe('/workspaces');
    expect(location(res).search).toBe('');
    expect(res.headers.get('set-cookie')).toContain('sb-127-auth-token=refreshed');
  });
});
