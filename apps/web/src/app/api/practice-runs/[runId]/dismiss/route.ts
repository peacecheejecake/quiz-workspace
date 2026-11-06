// UX12-RESUME relay: `지우기` takes a run out of the 이어 풀기 list; the run and its attempts stay.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  ctx: RouteContext<'/api/practice-runs/[runId]/dismiss'>,
) {
  const { runId } = await ctx.params;
  if (!isUuid(runId)) return notFound();
  return relayToApi(`/practice-runs/${runId}/dismiss`, { method: 'POST' });
}
