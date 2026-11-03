// ASK-01 relay: `첨부한 문제 빼기` — later messages carry no question context (DELETE → the
// conversation without its attachment).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: Request,
  ctx: RouteContext<'/api/ask/conversations/[conversationId]/attachment'>,
) {
  const { conversationId } = await ctx.params;
  if (!isUuid(conversationId)) return notFound();
  return relayToApi(`/ask/conversations/${conversationId}/attachment`, { method: 'DELETE' });
}
