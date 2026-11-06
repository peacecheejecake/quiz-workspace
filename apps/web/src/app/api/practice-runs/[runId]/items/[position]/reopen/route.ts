// UX12-RETRYINPLACE relay: `다시 풀기` in an unfinished run reopens the position.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  ctx: RouteContext<'/api/practice-runs/[runId]/items/[position]/reopen'>,
) {
  const { runId, position } = await ctx.params;
  if (!isUuid(runId) || !/^[1-9]\d{0,3}$/.test(position) || Number(position) > 5000)
    return notFound();
  return relayToApi(`/practice-runs/${runId}/items/${position}/reopen`, { method: 'POST' });
}
