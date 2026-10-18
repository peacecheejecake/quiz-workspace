// QGEN-01 relay: start generating variant drafts of a CONFIRMED question. The browser's
// Idempotency-Key makes a retried request after a lost response yield the same run.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

/** `{variation_types (≤ 3), candidate_count, difficulty}`. */
const MAX_GENERATION_BODY_BYTES = 4 * 1024;

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/questions/[questionId]/generations'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/questions/${questionId}/generations`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
    maxBodyBytes: MAX_GENERATION_BODY_BYTES,
  });
}
