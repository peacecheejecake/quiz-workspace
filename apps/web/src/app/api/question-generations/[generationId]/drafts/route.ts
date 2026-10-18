// QGEN-01 relay: the run's variant drafts in candidate order.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/question-generations/[generationId]/drafts'>,
) {
  const { generationId } = await ctx.params;
  if (!isUuid(generationId)) return notFound();
  return relayToApi(`/question-generations/${generationId}/drafts`, { method: 'GET' });
}
