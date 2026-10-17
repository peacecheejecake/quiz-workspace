// A3: per-request CSP nonce, HSTS, cross-origin write guard and session cookie flags, through the
// real `proxy()` entry point with a mocked @supabase/ssr client.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildContentSecurityPolicy,
  createNonce,
  isCrossOriginWrite,
  isHttpsRequest,
} from '../src/lib/http/security-headers';

interface CookieWrite {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

const getClaims = vi.fn();
let cookieWrites: CookieWrite[] = [];

vi.mock('@supabase/ssr', () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: { cookies: { setAll: (c: CookieWrite[], h: Record<string, string>) => void } },
  ) => ({
    auth: {
      getClaims: async () => {
        if (cookieWrites.length) options.cookies.setAll(cookieWrites, {});
        return getClaims() as unknown;
      },
    },
  }),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
process.env.NEXT_PUBLIC_API_BASE_URL = 'http://127.0.0.1:8000/';

const { proxy } = await import('../src/proxy');

const ORIGIN = 'http://127.0.0.1:3000';
const request = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(new URL(path, ORIGIN), {
    method: init.method ?? 'GET',
    headers: { host: '127.0.0.1:3000', ...init.headers },
  });

const directives = (csp: string) =>
  new Map(
    csp.split(';').map((d) => {
      const [name = '', ...values] = d.trim().split(/\s+/);
      return [name, values] as const;
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  cookieWrites = [];
  getClaims.mockResolvedValue({ data: null, error: null });
});

describe('buildContentSecurityPolicy', () => {
  const csp = directives(
    buildContentSecurityPolicy({
      nonce: 'abc123==',
      connectOrigins: ['http://127.0.0.1:54321/', 'https://api.example.com/v1', 'not a url'],
    }),
  );

  it('allows only nonce-carrying scripts (no unsafe-inline / unsafe-eval)', () => {
    expect(csp.get('script-src')).toEqual(["'self'", "'nonce-abc123=='", "'strict-dynamic'"]);
  });

  it('limits connections to self, Supabase and the API origins', () => {
    expect(csp.get('connect-src')).toEqual([
      "'self'",
      'http://127.0.0.1:54321',
      'https://api.example.com',
    ]);
  });

  it('locks framing, base, plugins and form targets', () => {
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp.has('upgrade-insecure-requests')).toBe(false);
  });

  it("adds 'unsafe-eval' only for next dev and upgrade-insecure-requests only over https", () => {
    const dev = directives(
      buildContentSecurityPolicy({ nonce: 'n', connectOrigins: [], dev: true }),
    );
    expect(dev.get('script-src')).toContain("'unsafe-eval'");
    const https = directives(
      buildContentSecurityPolicy({ nonce: 'n', connectOrigins: [], https: true }),
    );
    expect(https.has('upgrade-insecure-requests')).toBe(true);
  });
});

describe('createNonce', () => {
  it('is 128-bit base64 and unique per call', () => {
    const nonces = new Set(Array.from({ length: 50 }, createNonce));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe('isCrossOriginWrite', () => {
  const h = (headers: Record<string, string>) =>
    new Headers({ host: 'app.example.com', ...headers });

  it('lets reads through regardless of origin', () => {
    expect(isCrossOriginWrite('GET', h({ origin: 'https://evil.example' }))).toBe(false);
  });

  it('accepts same-origin writes (forwarded host first, like Next)', () => {
    expect(isCrossOriginWrite('POST', h({ origin: 'https://app.example.com' }))).toBe(false);
    expect(
      isCrossOriginWrite(
        'POST',
        new Headers({
          host: 'internal:3000',
          'x-forwarded-host': 'app.example.com',
          origin: 'https://app.example.com',
        }),
      ),
    ).toBe(false);
  });

  it('compares browser-serialized origins (default ports, case, IPv6, IDN)', () => {
    const write = (origin: string, host: string) =>
      isCrossOriginWrite('POST', new Headers({ host, origin }));
    expect(write('https://app.example.com', 'app.example.com:443')).toBe(false);
    expect(write('http://app.example.com', 'APP.Example.com:80')).toBe(false);
    expect(write('https://app.example.com', 'app.example.com:80')).toBe(true);
    expect(write('http://[::1]:3000', '[::1]:3000')).toBe(false);
    expect(write('http://[::1]:3001', '[::1]:3000')).toBe(true);
    expect(write('https://xn--bcher-kva.example', 'bücher.example')).toBe(false);
    expect(write('https://xn--bcher-kva.example', 'xn--bcher-kva.example')).toBe(false);
    expect(write('ftp://app.example.com', 'app.example.com')).toBe(true);
  });

  it('rejects writes from other origins, opaque origins and cross-site fetches', () => {
    expect(isCrossOriginWrite('POST', h({ origin: 'https://evil.example' }))).toBe(true);
    expect(
      isCrossOriginWrite('DELETE', h({ origin: 'https://app.example.com.evil.example' })),
    ).toBe(true);
    expect(isCrossOriginWrite('POST', h({ origin: 'null' }))).toBe(true);
    expect(isCrossOriginWrite('POST', h({ 'sec-fetch-site': 'cross-site' }))).toBe(true);
    expect(isCrossOriginWrite('POST', h({}))).toBe(false); // non-browser client, no Origin
  });
});

describe('isHttpsRequest', () => {
  it('trusts the forwarded protocol, else the URL', () => {
    expect(isHttpsRequest(new Headers({ 'x-forwarded-proto': 'https' }))).toBe(true);
    expect(isHttpsRequest(new Headers({ 'x-forwarded-proto': 'http' }), new URL('https://a'))).toBe(
      false,
    );
    expect(isHttpsRequest(new Headers(), new URL('https://a'))).toBe(true);
    expect(isHttpsRequest(new Headers(), new URL('http://a'))).toBe(false);
  });
});

describe('proxy()', () => {
  it('sends a fresh nonce CSP on the response and forwards it to the render', async () => {
    const first = await proxy(request('/login'));
    const second = await proxy(request('/login'));
    const csp = first.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];

    expect(nonce).toBeTruthy();
    expect(second.headers.get('content-security-policy')).not.toBe(csp);
    // NextResponse.next({ request }) forwards overridden request headers to the page render.
    expect(first.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
    expect(first.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(directives(csp).get('connect-src')).toEqual([
      "'self'",
      'http://127.0.0.1:54321',
      'http://127.0.0.1:8000',
    ]);
    expect(first.headers.get('strict-transport-security')).toBeNull();
  });

  it('keeps the CSP on auth redirects', async () => {
    const res = await proxy(request('/workspaces'));
    expect(res.status).toBe(307);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('adds HSTS behind an https edge', async () => {
    const res = await proxy(request('/login', { headers: { 'x-forwarded-proto': 'https' } }));
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
  });

  it('rejects a cross-origin POST before any session or action handling', async () => {
    const res = await proxy(
      request('/login', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'next-action': 'deadbeef' },
      }),
    );
    expect(res.status).toBe(403);
    expect(getClaims).not.toHaveBeenCalled();
  });

  it('lets a same-origin POST through', async () => {
    const res = await proxy(request('/login', { method: 'POST', headers: { origin: ORIGIN } }));
    expect(res.status).toBe(200);
  });
});

describe('session cookie flags', () => {
  const sessionCookie = (res: Response) =>
    (res.headers.get('set-cookie') ?? '').split(/,(?=\s*[\w-]+=)/).find((c) => c.includes('sb-'));

  it('are HttpOnly and SameSite=Lax, without Secure over plain http (local)', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: 'u1' } }, error: null });
    cookieWrites = [
      { name: 'sb-127-auth-token', value: 'v', options: { path: '/', httpOnly: false } },
    ];
    const cookie = sessionCookie(await proxy(request('/workspaces'))) ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).not.toMatch(/Secure/i);
  });

  it('add Secure over https', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: 'u1' } }, error: null });
    cookieWrites = [{ name: 'sb-127-auth-token', value: 'v', options: { path: '/' } }];
    const res = await proxy(request('/workspaces', { headers: { 'x-forwarded-proto': 'https' } }));
    expect(sessionCookie(res)).toMatch(/;\s*Secure/i);
  });
});
