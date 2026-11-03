// ASK-01 relay: `다시 생성` — a new answer version of the last question (the older one stays).
// The browser's Idempotency-Key is forwarded so a double press is one version.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/ask/messages/[messageId]/regenerate'>,
) {
  const { messageId } = await ctx.params;
  if (!isUuid(messageId)) return notFound();
  return relayToApi(`/ask/messages/${messageId}/regenerate`, {
    method: 'POST',
    idempotencyFrom: request,
  });
}
