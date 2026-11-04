// ASK-01 relay: ask a question (POST {question, scope?} → 202 with the answer to stream). The
// browser's Idempotency-Key is forwarded so a double press is one question; a 429 keeps its
// Retry-After.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

/** A question (FastAPI caps it far below this) and its scope ids. */
const MAX_QUESTION_BODY_BYTES = 128 * 1024;

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/ask/conversations/[conversationId]/messages'>,
) {
  const { conversationId } = await ctx.params;
  if (!isUuid(conversationId)) return notFound();
  return relayToApi(`/ask/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
    maxBodyBytes: MAX_QUESTION_BODY_BYTES,
  });
}
