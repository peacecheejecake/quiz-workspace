// QVIEW-01 relay: a practice run's counts, progress and summary (no content). The run is its
// creator's only: FastAPI answers 404 to anyone else.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: RouteContext<'/api/practice-runs/[runId]'>) {
  const { runId } = await ctx.params;
  if (!isUuid(runId)) return notFound();
  return relayToApi(`/practice-runs/${runId}`, { method: 'GET' });
}
