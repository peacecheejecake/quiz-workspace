// UX12-OPEN: the browser side of `practice-open`; the relay keeps FastAPI's answer and its timing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openQuestionPractice, practiceOpenPath } from '../src/lib/questions/practice-open-client';

const WS = '55555555-5555-4555-8555-555555555555';
const OTHER_WS = '55555555-5555-4555-8555-000000000002';
const Q = '22222222-2222-4222-8222-000000000001';
const KEY = '33333333-3333-4333-8333-000000000001';

function opened(workspaceId = WS) {
  return {
    session: { id: 'session', workspace_id: workspaceId },
    result: null,
    reused: false,
    reset_epoch: 0,
    previous_revision: false,
    active_revision_id: 'revision',
    latest_attempt_id: null,
  };
}

function respondWith(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status }));
}

function sentBody(fetchImpl: ReturnType<typeof respondWith>): unknown {
  const init = fetchImpl.mock.calls[0]?.[1];
  return JSON.parse(String(init?.body));
}

afterEach(() => vi.unstubAllGlobals());

describe('openQuestionPractice', () => {
  it('posts to the route handler with the opening key', async () => {
    const fetchImpl = respondWith(200, opened());
    const result = await openQuestionPractice(WS, Q, KEY, {}, fetchImpl);
    expect(result).toEqual({ ok: true, data: opened() });
    const [path, init] = fetchImpl.mock.calls[0] ?? [];
    expect(path).toBe(practiceOpenPath(Q));
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('idempotency-key')).toBe(KEY);
    expect(sentBody(fetchImpl)).toEqual({});
  });

  it('sends the cached session with its baseline, or force_new', async () => {
    const cached = respondWith(200, opened());
    await openQuestionPractice(
      WS,
      Q,
      KEY,
      { cached: { sessionId: 'session', baselineAttemptId: null } },
      cached,
    );
    expect(sentBody(cached)).toEqual({ cached_session_id: 'session', baseline_attempt_id: null });
    const forced = respondWith(200, opened());
    await openQuestionPractice(WS, Q, KEY, { forceNew: true }, forced);
    const another = respondWith(200, opened(WS));
    await openQuestionPractice(
      WS,
      Q,
      KEY,
      { cached: { sessionId: 's', baselineAttemptId: 'a', anotherTry: true } },
      another,
    );
    expect(sentBody(another)).toEqual({
      cached_session_id: 's',
      baseline_attempt_id: 'a',
      cached_another_try: true,
    });
    expect(sentBody(forced)).toEqual({ force_new: true });
  });

  it('never calls out with an id that is not a UUID', async () => {
    const fetchImpl = respondWith(200, opened());
    const result = await openQuestionPractice(WS, '../evil', KEY, {}, fetchImpl);
    expect(result).toMatchObject({ ok: false, kind: 'notFound' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a payload of another workspace', async () => {
    const result = await openQuestionPractice(WS, Q, KEY, {}, respondWith(200, opened(OTHER_WS)));
    expect(result).toMatchObject({ ok: false, kind: 'notFound' });
  });

  it('tells failures apart and survives a network error', async () => {
    const archived = await openQuestionPractice(
      WS,
      Q,
      KEY,
      {},
      respondWith(403, { type: 'urn:quiz-workspace:problem:workspace-archived' }),
    );
    expect(archived).toMatchObject({ ok: false, kind: 'archived' });
    const missing = await openQuestionPractice(WS, Q, KEY, {}, respondWith(404, {}));
    expect(missing).toMatchObject({ ok: false, kind: 'notFound' });
    const offline = await openQuestionPractice(
      WS,
      Q,
      KEY,
      {},
      vi.fn<typeof fetch>(async () => {
        throw new TypeError('offline');
      }),
    );
    expect(offline).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('sends a signed-out browser to the login page and back to the workspace', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    const result = await openQuestionPractice(WS, Q, KEY, {}, respondWith(401, {}));
    expect(result).toMatchObject({ ok: false, kind: 'unauthenticated' });
    expect(assign).toHaveBeenCalledWith(expect.stringContaining('/login'));
    expect(assign).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(`/workspaces/${WS}`)),
    );
  });
});
