// QGEN-01 relay: one generation run (status, current job, counts, error code).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/question-generations/[generationId]'>,
) {
  const { generationId } = await ctx.params;
  if (!isUuid(generationId)) return notFound();
  return relayToApi(`/question-generations/${generationId}`, { method: 'GET' });
}
