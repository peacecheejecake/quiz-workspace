// HISTORY-01 relay: older pages of the workspace's jobs (newest first, keyset cursor).
// FastAPI answers 404 for unknown/foreign workspaces.
import { forwardQuery, isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';
import { HISTORY_QUERY } from '@/lib/history/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/jobs'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  const query = forwardQuery(request, HISTORY_QUERY);
  if (query === null) return problemResponse(400, 'Bad Request', 'Malformed query.');
  return relayToApi(`/workspaces/${workspaceId}/jobs${query}`, { method: 'GET' });
}
