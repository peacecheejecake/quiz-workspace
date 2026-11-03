// ASK-01 relay: an answer's Server-Sent Events, streamed through unchanged (lib/http/sse-relay.ts:
// the token goes upstream in a header, `Last-Event-ID` resumes, WebKit gets its sniffing padding).
import { isUuid, notFound } from '@/lib/documents/bff';
import { relaySse } from '@/lib/http/sse-relay';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/ask/messages/[messageId]/stream'>,
) {
  const { messageId } = await ctx.params;
  if (!isUuid(messageId)) return notFound();
  return relaySse(`/ask/messages/${messageId}/stream`, request);
}
