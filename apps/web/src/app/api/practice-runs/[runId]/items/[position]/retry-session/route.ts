import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/practice-runs/[runId]/items/[position]/retry-session'>,
) {
  const { runId, position } = await ctx.params;
  if (!isUuid(runId) || !/^[1-9]\d{0,3}$/.test(position) || Number(position) > 5000)
    return notFound();
  return relayToApi(`/practice-runs/${runId}/items/${position}/retry-session`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
    maxBodyBytes: 1024,
  });
}
