// AIEXPL-01 relays: only the gate parameters reach FastAPI (anything else is dropped, a malformed
// value is refused here), and the explanation stream is relayed like ASK-01's (padding, nosniff).
import { describe, expect, it, vi } from 'vitest';
import type * as Bff from '../src/lib/documents/bff';

const relay = vi.hoisted(() => ({ relayToApi: vi.fn() }));
vi.mock('@/lib/documents/bff', async (original) => ({
  ...(await original<typeof Bff>()),
  relayToApi: relay.relayToApi,
}));

const bank = await import('../src/app/api/questions/[questionId]/ai-explanation/route');
const mock = await import('../src/app/api/mock-exam-questions/[questionId]/ai-explanation/route');
const stream = await import('../src/app/api/ai-explanations/[explanationId]/stream/route');

const ID = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;

describe('AIEXPL-01 relays', () => {
  it('forwards only the gate of its kind', async () => {
    relay.relayToApi.mockResolvedValue(Response.json({}));
    await bank.GET(
      new Request(
        `http://web.test/api/questions/${ID}/ai-explanation?practice_session_id=${SESSION}&x=1`,
      ),
      ctx({ questionId: ID }),
    );
    expect(relay.relayToApi).toHaveBeenLastCalledWith(
      `/questions/${ID}/ai-explanation?practice_session_id=${SESSION}`,
      { method: 'GET' },
    );
    await mock.GET(
      new Request(`http://web.test/api/mock-exam-questions/${ID}/ai-explanation?view=manage`),
      ctx({ questionId: ID }),
    );
    expect(relay.relayToApi).toHaveBeenLastCalledWith(
      `/mock-exam-questions/${ID}/ai-explanation?view=manage`,
      { method: 'GET' },
    );
  });

  it('refuses a malformed gate and an unknown id before FastAPI', async () => {
    relay.relayToApi.mockClear();
    const bad = await bank.GET(
      new Request(`http://web.test/api/questions/${ID}/ai-explanation?view=manage`),
      ctx({ questionId: ID }),
    );
    expect(bad.status).toBe(400);
    const unknown = await bank.POST(
      new Request('http://web.test/api/questions/nope/ai-explanation', { method: 'POST' }),
      ctx({ questionId: 'nope' }),
    );
    expect(unknown.status).toBe(404);
    expect(relay.relayToApi).not.toHaveBeenCalled();
  });

  it('relays the stream with the padding comment and nosniff', async () => {
    const events = 'id: 1\nevent: delta\ndata: {"seq":0,"text":"가"}\n\n';
    relay.relayToApi.mockResolvedValueOnce(
      new Response(events, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const res = await stream.GET(
      new Request(`http://web.test/api/ai-explanations/${ID}/stream?view=detail`),
      ctx({ explanationId: ID }),
    );
    expect(relay.relayToApi).toHaveBeenLastCalledWith(
      `/ai-explanations/${ID}/stream?view=detail`,
      expect.objectContaining({ method: 'GET', stream: true }),
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const text = await res.text();
    expect(text.startsWith(':')).toBe(true);
    expect(text.endsWith(events)).toBe(true);
  });
});
