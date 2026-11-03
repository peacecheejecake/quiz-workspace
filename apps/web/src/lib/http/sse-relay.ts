// Server-Sent Events relayed from FastAPI (ASK-01 answers, AIEXPL-01 AI explanations): the
// server-verified access token goes upstream in the Authorization header (never in a URL), the
// browser's `Last-Event-ID` resumes after the last event it has, and the upstream request ends
// when the browser disconnects.
//
// WebKit holds a response body back until it has enough bytes to sniff its type, so small deltas
// arrived only when the stream ended. The relay marks the stream `nosniff` and opens it with an
// SSE comment (ignored by every SSE reader) that fills that buffer at once.
import { relayToApi } from '@/lib/documents/bff';

const PADDING = new TextEncoder().encode(`:${' '.repeat(2048)}\n\n`);

/** Relays the SSE response of `path` (built from validated ids and query values). */
export async function relaySse(path: string, request: Request): Promise<Response> {
  const upstream = await relayToApi(path, {
    method: 'GET',
    stream: true,
    signal: request.signal,
    lastEventIdFrom: request,
  });
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!upstream.ok || !upstream.body || !contentType.includes('text/event-stream')) {
    return upstream;
  }
  const headers = new Headers(upstream.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(prepend(PADDING, upstream.body), { status: upstream.status, headers });
}

/** `first`, then every chunk of `rest` as it arrives (cancelling it when the reader goes away). */
function prepend(first: Uint8Array, rest: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = rest.getReader();
  let sent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(first);
        return;
      }
      try {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
