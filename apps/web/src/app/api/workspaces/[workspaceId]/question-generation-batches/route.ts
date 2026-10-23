// QGEN-MULTI relay: start a batch variant generation (several selected or randomly picked
// sources). The browser's Idempotency-Key makes a retried request after a lost response yield
// the same batch.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

/** `{selection: {mode, question_ids (≤ 20) | count + filters}, variation_types, ...}`. */
const MAX_BATCH_BODY_BYTES = 8 * 1024;

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/question-generation-batches'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/question-generation-batches`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
    maxBodyBytes: MAX_BATCH_BODY_BYTES,
  });
}
