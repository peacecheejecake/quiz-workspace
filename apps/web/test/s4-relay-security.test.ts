// S4: the share relay builds every upstream request from scratch. Whatever the browser sends —
// a forged relay identity, a bearer token, X-Forwarded-For, other cookies — never reaches
// FastAPI; only the share cookie, the server-verified access token (fork) and the signed identity
// the relay derived itself do.
import { describe, expect, it, vi } from 'vitest';
import { SHARE_COOKIE, exchangeSession, relayForkStart, relayShared } from '@/lib/shared/bff';
import { clientHeadersFor } from '@/lib/shared/context';

const SHARE = '11111111-2222-4333-8444-555555555555';
const SESSION = `v1.${'a'.repeat(32)}.1800000000.${'m'.repeat(43)}`;
const HOSTILE = {
  origin: 'https://web.test',
  authorization: 'Bearer attacker-token',
  'x-quiz-relay-client': 'victim',
  'x-quiz-relay-signature': 'f'.repeat(64),
  'x-forwarded-for': '203.0.113.66',
  'x-real-ip': '203.0.113.66',
  forwarded: 'for=203.0.113.66',
  cookie: `sb-127-auth-token=base64-secret; ${SHARE_COOKIE}=${SESSION}; other=1`,
  'idempotency-key': 'k-1',
};

function capture() {
  return vi.fn<typeof fetch>(async () => new Response('{}', { status: 404 }));
}

function sent(fetchImpl: ReturnType<typeof capture>): Record<string, string> {
  const init = fetchImpl.mock.calls[0]?.[1];
  return Object.fromEntries(
    Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );
}

const FORBIDDEN = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-quiz-relay-signature'];

describe('share relay upstream headers', () => {
  it('exchange forwards Origin and nothing the browser could forge', async () => {
    const fetchImpl = capture();
    await exchangeSession(
      new Request(`https://web.test/api/shared/${SHARE}/sessions`, {
        method: 'POST',
        headers: HOSTILE,
        body: '{"secret":"s"}',
      }),
      SHARE,
      { apiBaseUrl: 'http://api.test', secure: true, fetch: fetchImpl },
    );
    const headers = sent(fetchImpl);
    expect(headers.origin).toBe('https://web.test');
    for (const name of [...FORBIDDEN, 'authorization', 'cookie', 'x-quiz-relay-client']) {
      expect(headers[name], name).toBeUndefined();
    }
  });

  it('reads forward the share cookie only', async () => {
    const fetchImpl = capture();
    await relayShared(
      new Request(`https://web.test/api/shared/${SHARE}`, { headers: HOSTILE }),
      SHARE,
      '',
      { apiBaseUrl: 'http://api.test', secure: true, fetch: fetchImpl },
    );
    const headers = sent(fetchImpl);
    expect(headers.cookie).toBe(`${SHARE_COOKIE}=${SESSION}`);
    for (const name of [...FORBIDDEN, 'authorization', 'x-quiz-relay-client', 'origin']) {
      expect(headers[name], name).toBeUndefined();
    }
  });

  it('fork uses the verified token, never the browser Authorization header', async () => {
    const request = () =>
      new Request(`https://web.test/api/shared/${SHARE}/forks`, {
        method: 'POST',
        headers: HOSTILE,
        body: '{"name":"f"}',
      });
    const ctx = (fetchImpl: typeof fetch) => ({
      apiBaseUrl: 'http://api.test',
      secure: true,
      fetch: fetchImpl,
    });
    const signedOut = capture();
    const res = await relayForkStart(request(), SHARE, ctx(signedOut), null);
    expect(res.status).toBe(401);
    expect(signedOut).not.toHaveBeenCalled();

    const fetchImpl = capture();
    await relayForkStart(request(), SHARE, ctx(fetchImpl), 'verified.access.token');
    const headers = sent(fetchImpl);
    expect(headers.authorization).toBe('Bearer verified.access.token');
    expect(headers.cookie).toBe(`${SHARE_COOKIE}=${SESSION}`);
    for (const name of [...FORBIDDEN, 'x-quiz-relay-client']) {
      expect(headers[name], name).toBeUndefined();
    }
  });

  it('derives the identity only from the configured edge header, never from X-Forwarded-For', () => {
    const env = { RELAY_CLIENT_SECRET: 'r'.repeat(32), RELAY_CLIENT_IP_HEADER: 'x-real-ip' };
    const a = clientHeadersFor(new Headers({ 'x-real-ip': '198.51.100.1' }), env);
    const b = clientHeadersFor(
      new Headers({ 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '203.0.113.66' }),
      env,
    );
    expect(b).toEqual(a);
    // No configured header: no identity at all (FastAPI keys on the socket peer).
    expect(
      clientHeadersFor(new Headers({ 'x-forwarded-for': '203.0.113.66' }), {
        RELAY_CLIENT_SECRET: 'r'.repeat(32),
      }),
    ).toBeUndefined();
  });
});
