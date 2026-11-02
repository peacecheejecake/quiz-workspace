// QVIEW-01 relay: one position of a practice run — the question without answers, or, once that
// position was submitted, the submitted answer with its result and answers (QVIEW-01-C03).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/practice-runs/[runId]/items/[position]'>,
) {
  const { runId, position } = await ctx.params;
  if (!isUuid(runId) || !/^[1-9]\d{0,3}$/.test(position)) return notFound();
  return relayToApi(`/practice-runs/${runId}/items/${position}`, { method: 'GET' });
}
