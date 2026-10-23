// QGEN-MULTI relay: a batch's runs (one per source) with their progress.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/question-generation-batches/[batchId]'>,
) {
  const { workspaceId, batchId } = await ctx.params;
  if (!isUuid(workspaceId) || !isUuid(batchId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/question-generation-batches/${batchId}`, {
    method: 'GET',
  });
}
