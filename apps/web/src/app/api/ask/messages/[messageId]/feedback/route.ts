// ASK-01 relay: `도움이 안 됨` with one reason code (PUT {reason}); no free text.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

const MAX_FEEDBACK_BODY_BYTES = 256;

export async function PUT(
  request: Request,
  ctx: RouteContext<'/api/ask/messages/[messageId]/feedback'>,
) {
  const { messageId } = await ctx.params;
  if (!isUuid(messageId)) return notFound();
  return relayToApi(`/ask/messages/${messageId}/feedback`, {
    method: 'PUT',
    body: request,
    maxBodyBytes: MAX_FEEDBACK_BODY_BYTES,
  });
}
