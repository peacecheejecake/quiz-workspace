// QPLAY-01 BFF actions: untrusted input is validated before FastAPI is called, a response for
// another session is refused, and conflicts map to their own messages.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyQuestionFailure } from '../src/lib/questions/problems';

const calls: { path: string; init: unknown }[] = [];
let respond: (path: string) => { data?: unknown; error?: unknown; response: Response } = () => ({
  response: new Response(null, { status: 500 }),
});

vi.mock('../src/lib/questions/server', () => ({
  callQuestionApi: async (
    _returnTo: string,
    call: (api: unknown) => Promise<{ data?: unknown; error?: unknown; response: Response }>,
  ) => {
    const api = {
      POST: async (path: string, init: unknown) => {
        calls.push({ path, init });
        return respond(path);
      },
    };
    const { data, error, response } = await call(api);
    return response.ok
      ? { ok: true, data }
      : { ok: false, failure: classifyQuestionFailure(response.status, error) };
  },
}));

const { submitPracticeAction, selfGradePracticeAction } =
  await import('../src/lib/questions/practice-actions');

const WS = '55555555-5555-4555-8555-555555555555';
const SESSION = '99999999-9999-4999-8999-999999999999';
const OTHER = '99999999-9999-4999-8999-000000000000';

beforeEach(() => {
  calls.length = 0;
});

function ok(data: unknown) {
  return { data, response: new Response(null, { status: 200 }) };
}

describe('submitPracticeAction', () => {
  it('rejects malformed ids and answers without calling the API', async () => {
    const bad: unknown[] = [
      { selected_option_ids: [] },
      { selected_option_ids: [1] },
      { selected_option_ids: [''] },
      { selected_option_ids: Array.from({ length: 51 }, (_, i) => `o${i}`) },
      { answer_text: '   ' },
      { answer_text: 'x'.repeat(20_001) },
      {},
      null,
    ];
    for (const answer of bad) {
      const result = await submitPracticeAction(WS, SESSION, answer as never);
      expect(result).toMatchObject({ ok: false, kind: 'invalid' });
    }
    expect(await submitPracticeAction(WS, 'not-a-uuid', { answer_text: 'a' })).toMatchObject({
      ok: false,
      kind: 'notFound',
    });
    expect(calls).toEqual([]);
  });

  it('posts the option ids to the session and returns the graded result', async () => {
    respond = () => ok({ practice_session_id: SESSION, result: 'correct' });
    const result = await submitPracticeAction(WS, SESSION, { selected_option_ids: ['o3'] });
    expect(result).toMatchObject({ ok: true, data: { result: 'correct' } });
    expect(calls).toEqual([
      {
        path: '/api/v1/practice-sessions/{session_id}/submit',
        init: { params: { path: { session_id: SESSION } }, body: { selected_option_ids: ['o3'] } },
      },
    ]);
  });

  it('refuses a result that belongs to another session', async () => {
    respond = () => ok({ practice_session_id: OTHER, result: 'correct' });
    expect(await submitPracticeAction(WS, SESSION, { answer_text: 'a' })).toMatchObject({
      ok: false,
      kind: 'notFound',
    });
  });

  it('a second submit of the same session is reported as already submitted', async () => {
    respond = () => ({
      error: { type: 'urn:quiz-workspace:problem:practice-session-submitted' },
      response: new Response(null, { status: 409 }),
    });
    expect(await submitPracticeAction(WS, SESSION, { answer_text: 'a' })).toMatchObject({
      ok: false,
      kind: 'alreadySubmitted',
    });
  });
});

describe('selfGradePracticeAction', () => {
  it('accepts only correct/incorrect', async () => {
    expect(await selfGradePracticeAction(WS, SESSION, 'pending' as never)).toMatchObject({
      ok: false,
      kind: 'invalid',
    });
    expect(calls).toEqual([]);
  });

  it('posts the grade and maps a non-pending session conflict', async () => {
    respond = () => ok({ practice_session_id: SESSION, result: 'incorrect' });
    expect(await selfGradePracticeAction(WS, SESSION, 'incorrect')).toMatchObject({ ok: true });
    expect(calls[0]).toMatchObject({
      path: '/api/v1/practice-sessions/{session_id}/self-grade',
      init: { body: { result: 'incorrect' } },
    });
    respond = () => ({
      error: { type: 'urn:quiz-workspace:problem:practice-session-not-pending' },
      response: new Response(null, { status: 409 }),
    });
    expect(await selfGradePracticeAction(WS, SESSION, 'correct')).toMatchObject({
      ok: false,
      kind: 'notPending',
    });
  });
});
