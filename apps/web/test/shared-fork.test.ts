// WS-FORK-01 fork relay and browser client: the relay adds the verified Bearer token, the share
// cookie and the Origin (never the token from the browser), passes FastAPI's answer through and
// clears the share cookie when the link is over; the client classifies every documented refusal.
import { describe, expect, it, vi } from 'vitest';
import { SHARE_COOKIE, relayForkStart, type RelayContext } from '@/lib/shared/bff';
import {
  ForkRequestError,
  classifyForkFailure,
  createForkClient,
  forkEndMessage,
  forkFailureMessage,
  isTerminal,
  pollDelay,
  suggestedForkName,
  validateForkName,
} from '@/lib/shared/fork';

const SHARE = '11111111-2222-4333-8444-555555555555';
const FORK = '22222222-3333-4444-8555-666666666666';
const API = 'http://api.test';
const TOKEN = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
const SESSION = `v1.${'a'.repeat(32)}.1800000000.${'m'.repeat(43)}`;
const P = 'urn:quiz-workspace:problem:';

function ctx(fetchImpl: typeof fetch, secure = false): RelayContext {
  return {
    apiBaseUrl: API,
    secure,
    fetch: fetchImpl,
    clientHeaders: { 'x-quiz-relay-client': 'c', 'x-quiz-relay-signature': 's' },
  };
}

function forkRequest(init: { headers?: Record<string, string>; body?: string } = {}) {
  return new Request(`https://web.test/api/shared/${SHARE}/forks`, {
    method: 'POST',
    headers: {
      origin: 'https://web.test',
      'content-type': 'application/json',
      cookie: `sb-x-auth-token=zzz; ${SHARE_COOKIE}=${SESSION}`,
      'idempotency-key': 'key-1',
      ...init.headers,
    },
    body: init.body ?? JSON.stringify({ name: '내 Fork' }),
  });
}

const problem = (status: number, type: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type, status, title: 't' }), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });

const FORK_BODY = {
  id: FORK,
  job_id: FORK,
  status: 'PENDING',
  progress: 0,
  name: '내 Fork',
  target_workspace_id: null,
  error_code: null,
  created_at: '2026-10-18T00:00:00Z',
  updated_at: '2026-10-18T00:00:00Z',
  completed_at: null,
};

describe('fork start relay', () => {
  it('forwards body, Bearer, share cookie only, Origin, Idempotency-Key and client id', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(FORK_BODY, { status: 202 }));
    const res = await relayForkStart(forkRequest(), SHARE, ctx(fetchImpl), TOKEN);
    expect(res.status).toBe(202);
    expect(res.headers.get('cache-control')).toBe('private, no-store, no-transform');
    expect(await res.json()).toEqual(FORK_BODY);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${API}/api/v1/shared/${SHARE}/forks`);
    expect(String(url)).not.toContain(TOKEN);
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers.cookie).toBe(`${SHARE_COOKIE}=${SESSION}`);
    expect(headers.origin).toBe('https://web.test');
    expect(headers['idempotency-key']).toBe('key-1');
    expect(headers['x-quiz-relay-client']).toBe('c');
    expect(headers['x-quiz-relay-signature']).toBe('s');
    expect(init?.body).toBe(JSON.stringify({ name: '내 Fork' }));
  });

  it('refuses without a verified token before calling the API', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect((await relayForkStart(forkRequest(), SHARE, ctx(fetchImpl), null)).status).toBe(401);
    expect((await relayForkStart(forkRequest(), SHARE, ctx(fetchImpl), 'a b')).status).toBe(401);
    expect((await relayForkStart(forkRequest(), 'nope', ctx(fetchImpl), TOKEN)).status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies and Idempotency-Keys', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const bad = await relayForkStart(forkRequest({ body: '[1]' }), SHARE, ctx(fetchImpl), TOKEN);
    expect(bad.status).toBe(400);
    const big = forkRequest({ body: JSON.stringify({ name: 'x'.repeat(5000) }) });
    expect((await relayForkStart(big, SHARE, ctx(fetchImpl), TOKEN)).status).toBe(400);
    const key = forkRequest({ headers: { 'idempotency-key': 'has space' } });
    expect((await relayForkStart(key, SHARE, ctx(fetchImpl), TOKEN)).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes refusals through, keeps Retry-After and clears the cookie when the link is over', async () => {
    const limited = await relayForkStart(
      forkRequest(),
      SHARE,
      ctx(async () => problem(429, 'about:blank', { 'retry-after': '7' })),
      TOKEN,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('7');
    expect(limited.headers.get('set-cookie')).toBeNull();

    const over = await relayForkStart(
      forkRequest(),
      SHARE,
      ctx(async () => problem(404, `${P}share-unavailable`), true),
      TOKEN,
    );
    expect(over.status).toBe(404);
    expect(over.headers.get('set-cookie')).toMatch(
      new RegExp(`^${SHARE_COOKIE}=; Path=/api/shared/${SHARE}; Max-Age=0; HttpOnly`),
    );

    const off = await relayForkStart(
      forkRequest(),
      SHARE,
      ctx(async () => problem(403, `${P}fork-not-allowed`)),
      TOKEN,
    );
    expect(off.status).toBe(403);
    expect(off.headers.get('set-cookie')).toBeNull();
  });

  it('answers 503 when the API is unreachable', async () => {
    const res = await relayForkStart(
      forkRequest(),
      SHARE,
      ctx(async () => {
        throw new Error('down');
      }),
      TOKEN,
    );
    expect(res.status).toBe(503);
  });
});

describe('fork client', () => {
  it('classifies every documented refusal', () => {
    expect(classifyForkFailure(401, {})).toBe('unauthenticated');
    expect(classifyForkFailure(403, { type: `${P}share-session-required` })).toBe('unavailable');
    expect(classifyForkFailure(404, { type: `${P}share-unavailable` })).toBe('unavailable');
    expect(classifyForkFailure(403, { type: `${P}fork-not-allowed` })).toBe('notAllowed');
    expect(classifyForkFailure(403, { detail: 'Origin not allowed.' })).toBe('failed');
    expect(classifyForkFailure(429, {})).toBe('rateLimited');
    expect(classifyForkFailure(409, { type: `${P}idempotency-key-reused` })).toBe('keyReused');
    expect(classifyForkFailure(409, { type: `${P}fork-too-large` })).toBe('tooLarge');
    expect(classifyForkFailure(422, {})).toBe('invalidName');
    expect(classifyForkFailure(500, undefined)).toBe('failed');
  });

  it('starts through the share relay with the key and polls /api/me/forks', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(FORK_BODY, { status: 202 }));
    const client = createForkClient(SHARE, fetchImpl);
    await client.start('내 Fork', 'key-9');
    await client.get(FORK);
    const [startUrl, startInit] = fetchImpl.mock.calls[0] ?? [];
    expect(startUrl).toBe(`/api/shared/${SHARE}/forks`);
    expect(startInit?.method).toBe('POST');
    expect((startInit?.headers as Record<string, string>)['idempotency-key']).toBe('key-9');
    expect(startInit?.body).toBe(JSON.stringify({ name: '내 Fork' }));
    expect(startInit?.credentials).toBe('same-origin');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(`/api/me/forks/${FORK}`);
  });

  it('turns 429 into a rate-limit error with the wait and network errors into network', async () => {
    const limited = createForkClient(SHARE, async () =>
      problem(429, 'about:blank', { 'retry-after': '12' }),
    );
    const error = await limited.start('a', 'k').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForkRequestError);
    expect((error as ForkRequestError).retryAfterSeconds).toBe(12);
    expect(forkFailureMessage(error)).toContain('12초');
    const offline = createForkClient(SHARE, async () => {
      throw new TypeError('offline');
    });
    await expect(offline.get(FORK)).rejects.toMatchObject({ kind: 'network' });
  });

  it('validates names like the API (trimmed, 1-200, no control characters)', () => {
    expect(validateForkName('  a  ')).toEqual({ name: 'a' });
    expect(validateForkName('   ')).toHaveProperty('error');
    expect(validateForkName('가'.repeat(200))).toEqual({ name: '가'.repeat(200) });
    expect(validateForkName('가'.repeat(201))).toHaveProperty('error');
    expect(validateForkName('a\tb')).toHaveProperty('error');
    expect([...suggestedForkName('😀'.repeat(250))]).toHaveLength(200);
  });

  it('describes terminal states and backs off polling', () => {
    expect(isTerminal('COPYING')).toBe(false);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(forkEndMessage({ status: 'CANCELLED', error_code: 'share_unavailable' })).toContain(
      '링크를 사용할 수 없',
    );
    expect(forkEndMessage({ status: 'FAILED', error_code: 'fork_failed' })).toContain('실패');
    expect(pollDelay(0)).toBe(1000);
    expect(pollDelay(10)).toBe(2000);
    expect(pollDelay(100)).toBe(5000);
  });
});
