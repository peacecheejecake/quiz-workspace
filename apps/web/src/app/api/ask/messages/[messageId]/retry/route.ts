// ASK-01 relay: `다시 시도` — a new answer to the question of a failed or stopped one (which stays).
// The browser's Idempotency-Key is forwarded so a double press is one answer.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/ask/messages/[messageId]/retry'>,
) {
  const { messageId } = await ctx.params;
  if (!isUuid(messageId)) return notFound();
  return relayToApi(`/ask/messages/${messageId}/retry`, {
    method: 'POST',
    idempotencyFrom: request,
  });
}
