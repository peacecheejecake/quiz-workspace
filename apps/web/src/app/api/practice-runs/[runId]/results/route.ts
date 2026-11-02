// QVIEW-01 relay: one page of a practice run's per-position results (no answers).
import { forwardQuery, isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/practice-runs/[runId]/results'>,
) {
  const { runId } = await ctx.params;
  if (!isUuid(runId)) return notFound();
  const query = forwardQuery(request, { offset: /^\d{1,4}$/, limit: /^\d{1,3}$/ });
  if (query === null) return problemResponse(400, 'Bad Request', 'Malformed query.');
  return relayToApi(`/practice-runs/${runId}/results${query}`, { method: 'GET' });
}
