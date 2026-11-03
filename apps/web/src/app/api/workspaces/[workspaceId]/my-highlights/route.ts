// HILITE-01 relay (read): the reader's explanation highlights of the "챕터 없음" Heatmap group
// (`?chapter=none` only; there is no workspace-wide list).
import { forwardQuery, isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

const QUERY = { chapter: /^none$/ } as const;

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/my-highlights'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  const query = forwardQuery(request, QUERY);
  if (query !== '?chapter=none') return problemResponse(400, 'Bad Request', 'Malformed query.');
  return relayToApi(`/workspaces/${workspaceId}/my-highlights${query}`, { method: 'GET' });
}
