// ASK-01 relay: one message (the streaming fallback polls it: the text so far, or the final state).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: RouteContext<'/api/ask/messages/[messageId]'>) {
  const { messageId } = await ctx.params;
  if (!isUuid(messageId)) return notFound();
  return relayToApi(`/ask/messages/${messageId}`, { method: 'GET' });
}
