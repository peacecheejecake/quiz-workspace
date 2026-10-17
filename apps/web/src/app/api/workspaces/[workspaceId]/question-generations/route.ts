// QGEN-01 relay: the workspace's generation runs (newest first), optionally of one source question.
import { forwardQuery, isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/question-generations'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  const query = forwardQuery(request, { source_question_id: UUID, limit: /^\d{1,3}$/ });
  if (query === null) return problemResponse(400, 'Bad Request', 'Malformed query.');
  return relayToApi(`/workspaces/${workspaceId}/question-generations${query}`, { method: 'GET' });
}
