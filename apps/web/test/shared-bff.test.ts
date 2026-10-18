import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SESSION_SECONDS,
  SHARE_COOKIE,
  exchangeSession,
  readCookie,
  relayShared,
  sharedQuery,
  upstreamSession,
  type RelayContext,
} from '@/lib/shared/bff';
import { clientAddress, clientHeadersFor, relayClientHeaders } from '@/lib/shared/context';

const SHARE = '11111111-2222-4333-8444-555555555555';
const API = 'http://api.test';
const SECRET = 'S'.repeat(43);
const TOKEN = `v1.${'a'.repeat(32)}.1800000000.${'m'.repeat(43)}`;

function ctx(fetchImpl: typeof fetch, secure = false): RelayContext {
  return { apiBaseUrl: API, secure, fetch: fetchImpl };
}

function upstream(status: number, init: { body?: unknown; headers?: HeadersInit } = {}) {
  const body = init.body === undefined ? null : JSON.stringify(init.body);
  return new Response(body, { status, headers: init.headers });
}

const PRIVACY = {
  'cache-control': 'private, no-store, no-transform',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
};

function expectPrivacy(res: Response) {
  for (const [k, v] of Object.entries(PRIVACY)) expect(res.headers.get(k)).toBe(v);
}

describe('share session exchange relay', () => {
  it('forwards the secret in the body with the Origin and re-scopes the cookie', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      upstream(204, {
        headers: {
          'set-cookie': `${SHARE_COOKIE}=${TOKEN}; HttpOnly; Max-Age=14400; Path=/api/v1/shared/${SHARE}; SameSite=lax; Secure`,
        },
      }),
    );
    const req = new Request(`https://web.test/api/shared/${SHARE}/sessions`, {
      method: 'POST',
      headers: { origin: 'https://web.test', 'content-type': 'application/json' },
      body: JSON.stringify({ secret: SECRET }),
    });
    const res = await exchangeSession(req, SHARE, ctx(fetchImpl, true));

    expect(res.status).toBe(204);
    expectPrivacy(res);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${API}/api/v1/shared/${SHARE}/sessions`);
    expect(String(url)).not.toContain(SECRET);
    expect(init?.body).toBe(JSON.stringify({ secret: SECRET }));
    expect((init?.headers as Record<string, string>).origin).toBe('https://web.test');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toBe(
      `${SHARE_COOKIE}=${TOKEN}; Path=/api/shared/${SHARE}; Max-Age=14400; HttpOnly; SameSite=Lax; Secure`,
    );
    expect(cookie.includes(SECRET)).toBe(false);
  });

  it('passes problems through without a cookie and rejects bad input locally', async () => {
    const problem = { type: 'urn:quiz-workspace:problem:share-unavailable', status: 404 };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      upstream(404, { body: problem, headers: { 'content-type': 'application/problem+json' } }),
    );
    const post = (body: string, id = SHARE) =>
      exchangeSession(
        new Request(`http://web.test/api/shared/${id}/sessions`, { method: 'POST', body }),
        id,
        ctx(fetchImpl),
      );
    const res = await post(JSON.stringify({ secret: SECRET }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(problem);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await post('[1]')).status).toBe(400);
    expect((await post('x'.repeat(2000))).status).toBe(400);
    expect((await post('{}', 'not-a-uuid')).status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps Retry-After on 429', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      upstream(429, { body: { status: 429 }, headers: { 'retry-after': '7' } }),
    );
    const res = await exchangeSession(
      new Request('http://web.test/x', { method: 'POST', body: '{"secret":"x"}' }),
      SHARE,
      ctx(fetchImpl),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
  });
});

describe('shared read relay', () => {
  it('forwards only the share cookie and clears it when the session is over', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      upstream(404, {
        body: { type: 'urn:quiz-workspace:problem:share-unavailable' },
        headers: { 'content-type': 'application/problem+json' },
      }),
    );
    const req = new Request(`http://web.test/api/shared/${SHARE}/questions`, {
      headers: { cookie: `sb-access=abc; ${SHARE_COOKIE}=${TOKEN}; other=1` },
    });
    const res = await relayShared(req, SHARE, '/questions', ctx(fetchImpl), { query: '?limit=5' });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${API}/api/v1/shared/${SHARE}/questions?limit=5`);
    const headers = init?.headers as Record<string, string>;
    expect(headers.cookie).toBe(`${SHARE_COOKIE}=${TOKEN}`);
    expect(headers.authorization).toBeUndefined();
    expect(res.status).toBe(404);
    expectPrivacy(res);
    expect(res.headers.get('set-cookie')).toBe(
      `${SHARE_COOKIE}=; Path=/api/shared/${SHARE}; Max-Age=0; HttpOnly; SameSite=Lax`,
    );
  });

  it('keeps the cookie on other errors and streams PDFs', async () => {
    const notFound = vi.fn<typeof fetch>(async () => upstream(404, { body: { detail: 'x' } }));
    const req = new Request('http://web.test/x', {
      headers: { cookie: `${SHARE_COOKIE}=${TOKEN}` },
    });
    const res = await relayShared(req, SHARE, '/questions/q', ctx(notFound));
    expect(res.headers.get('set-cookie')).toBeNull();

    const pdf = vi.fn<typeof fetch>(
      async () =>
        new Response('%PDF-1.7', {
          status: 200,
          headers: { 'content-type': 'application/pdf', 'content-length': '8' },
        }),
    );
    const out = await relayShared(req, SHARE, '/documents/d/pdf', ctx(pdf), { stream: true });
    expect(out.headers.get('content-type')).toBe('application/pdf');
    expect(out.headers.get('content-length')).toBe('8');
    expect(await out.text()).toBe('%PDF-1.7');
    expectPrivacy(out);
  });

  it('answers 503 without leaking upstream errors', async () => {
    const failing = vi.fn<typeof fetch>(async () => {
      throw new Error(`connect failed ${API}`);
    });
    const res = await relayShared(new Request('http://web.test/x'), SHARE, '', ctx(failing));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(API);
  });
});

describe('cookie helpers', () => {
  it('reads only well-formed share cookies', () => {
    expect(readCookie(`a=1; ${SHARE_COOKIE}=${TOKEN}`)).toBe(TOKEN);
    expect(readCookie(`${SHARE_COOKIE}=bad value`)).toBeNull();
    expect(readCookie(null)).toBeNull();
  });

  it('clamps the upstream Max-Age and rejects cookies without one', () => {
    const h = new Headers();
    h.append('set-cookie', `${SHARE_COOKIE}=${TOKEN}; Max-Age=999999; HttpOnly`);
    expect(upstreamSession(h)).toEqual({ value: TOKEN, maxAge: MAX_SESSION_SECONDS });
    const none = new Headers({ 'set-cookie': `${SHARE_COOKIE}=${TOKEN}; HttpOnly` });
    expect(upstreamSession(none)).toBeNull();
  });

  it('forwards only allowed, valid query parameters', () => {
    const req = new Request('http://web.test/x?limit=5&evil=1');
    expect(sharedQuery(req, { limit: /^[0-9]+$/ })).toBe('?limit=5');
    expect(sharedQuery(new Request('http://web.test/x?limit=a'), { limit: /^[0-9]+$/ })).toBeNull();
  });
});

describe('signed client identity for per-client limits', () => {
  const RELAY = 'r'.repeat(32);
  // Same vector as apps/api/tests/test_shared.py.
  const VECTOR = {
    'x-quiz-relay-client': '_sUlZaoM8Y9X189bOscoUDuJktLW99RtodEgEJCQKwI',
    'x-quiz-relay-signature': 'df6818bb97c1d1f06cf1872140d70f880001c5da2d1eec5d03a5e04ca89995d7',
  };

  it('signs a hash of the edge-reported address, never the address itself', () => {
    expect(relayClientHeaders(RELAY, '203.0.113.7')).toEqual(VECTOR);
    const headers = new Headers({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' });
    const env = { RELAY_CLIENT_SECRET: RELAY, RELAY_CLIENT_IP_HEADER: 'X-Real-IP' };
    expect(clientHeadersFor(headers, env)).toEqual(VECTOR);
    expect(JSON.stringify(clientHeadersFor(headers, env))).not.toContain('203.0.113.7');
    // First hop of a list; nothing without a secret (or a short one) or without the header.
    expect(clientAddress(new Headers({ 'x-real-ip': ' 1.2.3.4, 5.6.7.8' }), 'x-real-ip')).toBe(
      '1.2.3.4',
    );
    expect(clientHeadersFor(headers, { RELAY_CLIENT_IP_HEADER: 'x-real-ip' })).toBeUndefined();
    expect(clientHeadersFor(headers, { ...env, RELAY_CLIENT_SECRET: 'short' })).toBeUndefined();
    expect(clientHeadersFor(new Headers(), env)).toBeUndefined();
    expect(clientHeadersFor(headers, { RELAY_CLIENT_SECRET: RELAY })).toBeUndefined();
  });

  it('forwards the identity on exchanges and reads', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => upstream(404, { body: {} }));
    const withIdentity = { ...ctx(fetchImpl), clientHeaders: VECTOR };
    await exchangeSession(
      new Request('http://web.test/x', { method: 'POST', body: '{"secret":"x"}' }),
      SHARE,
      withIdentity,
    );
    await relayShared(new Request('http://web.test/x'), SHARE, '/search', withIdentity, {
      method: 'POST',
      body: new Request('http://web.test/x', { method: 'POST', body: '{"query":"q"}' }),
    });
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]?.headers).toMatchObject(VECTOR);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
