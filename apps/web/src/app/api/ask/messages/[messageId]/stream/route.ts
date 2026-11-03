// ASK-01 relay: an answer's Server-Sent Events, streamed through unchanged. The server-verified
// access token goes upstream in the Authorization header (never in a URL or query), the browser's
// `Last-Event-ID` resumes after the last delta it has, and the upstream request ends when the
// browser disconnects.
//
// WebKit holds a response body back until it has enough bytes to sniff its type, so an answer's
// small deltas arrived only when the stream ended. The relay marks the stream `nosniff` and opens
// it with an SSE comment (ignored by every SSE reader) that fills that buffer at once.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

const PADDING = new TextEncoder().encode(`:${' '.repeat(2048)}\n\n`);

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/ask/messages/[messageId]/stream'>,
) {
  const { messageId } = await ctx.params;
  if (!isUuid(messageId)) return notFound();
  const upstream = await relayToApi(`/ask/messages/${messageId}/stream`, {
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
