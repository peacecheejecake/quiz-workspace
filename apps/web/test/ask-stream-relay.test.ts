// ASK-01 answer stream relay (`/api/ask/messages/[id]/stream`): the event stream reaches the
// browser as it is written. WebKit holds a response body back until it has enough bytes to sniff
// its type, so the relay opens with an SSE comment that fills that buffer and marks the response
// `nosniff`; the upstream events follow unchanged.
import { describe, expect, it, vi } from 'vitest';
import type * as Bff from '../src/lib/documents/bff';

const relay = vi.hoisted(() => ({ relayToApi: vi.fn() }));
vi.mock('@/lib/documents/bff', async (original) => ({
  ...(await original<typeof Bff>()),
  relayToApi: relay.relayToApi,
}));

const { GET } = await import('../src/app/api/ask/messages/[messageId]/stream/route');

const ID = '11111111-1111-4111-8111-111111111111';

function upstream(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'private, no-store' },
  });
}

async function call(): Promise<Response> {
  return GET(new Request(`http://web.test/api/ask/messages/${ID}/stream`), {
    params: Promise.resolve({ messageId: ID }),
  } as never);
}

describe('ASK-01 answer stream relay', () => {
  it('ASK-01-AC01 opens with a padding comment, marks nosniff and passes the events through', async () => {
    const events = 'id: 1\nevent: delta\ndata: {"seq":1,"text":"가"}\n\n';
    relay.relayToApi.mockResolvedValueOnce(upstream(events));
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    if (!res.body) throw new Error('no body');
    const reader = res.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    // The first chunk is a comment alone, at least 2 KiB, so it is delivered before any event.
    expect(first.startsWith(':')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(true);
    expect(new TextEncoder().encode(first).byteLength).toBeGreaterThanOrEqual(2048);
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe(events);
  });

  it('ASK-01-AC06 passes a refusal through unchanged', async () => {
    relay.relayToApi.mockResolvedValueOnce(
      new Response('{"title":"Not Found"}', {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('{"title":"Not Found"}');
  });
});
