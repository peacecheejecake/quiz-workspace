// QVIEW-01 relay: `결과 보기` ends a practice run (positions not submitted count as skipped);
// finishing a finished run returns it unchanged.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  ctx: RouteContext<'/api/practice-runs/[runId]/finish'>,
) {
  const { runId } = await ctx.params;
  if (!isUuid(runId)) return notFound();
  return relayToApi(`/practice-runs/${runId}/finish`, { method: 'POST' });
}
