// ASK-01 relay: `답변 중지` — stops an unfinished answer, keeping the text so far (idempotent).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  ctx: RouteContext<'/api/ask/messages/[messageId]/cancel'>,
) {
  const { messageId } = await ctx.params;
  if (!isUuid(messageId)) return notFound();
  return relayToApi(`/ask/messages/${messageId}/cancel`, { method: 'POST' });
}
