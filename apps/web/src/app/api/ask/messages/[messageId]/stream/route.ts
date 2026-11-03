// ASK-01 relay: an answer's Server-Sent Events, streamed through unchanged. The server-verified
// access token goes upstream in the Authorization header (never in a URL or query), the browser's
// `Last-Event-ID` resumes after the last delta it has, and the upstream request ends when the
// browser disconnects.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/ask/messages/[messageId]/stream'>,
) {
  const { messageId } = await ctx.params;
  if (!isUuid(messageId)) return notFound();
  return relayToApi(`/ask/messages/${messageId}/stream`, {
    method: 'GET',
    stream: true,
    signal: request.signal,
    lastEventIdFrom: request,
  });
}
