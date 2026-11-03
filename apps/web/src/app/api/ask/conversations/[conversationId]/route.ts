// ASK-01 relay: one conversation with its messages (GET) and its deletion (DELETE, 204). Only its
// owner reaches it; everyone else gets FastAPI's 404.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/ask/conversations/[conversationId]'>,
) {
  const { conversationId } = await ctx.params;
  if (!isUuid(conversationId)) return notFound();
  return relayToApi(`/ask/conversations/${conversationId}`, { method: 'GET' });
}

export async function DELETE(
  _request: Request,
  ctx: RouteContext<'/api/ask/conversations/[conversationId]'>,
) {
  const { conversationId } = await ctx.params;
  if (!isUuid(conversationId)) return notFound();
  return relayToApi(`/ask/conversations/${conversationId}`, { method: 'DELETE' });
}
