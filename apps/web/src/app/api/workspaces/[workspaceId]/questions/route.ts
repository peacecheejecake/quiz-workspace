// DOC-02-AC11 relay: the workspace's confirmed questions with a source in one document (the bank
// list, answers included as for any member; FastAPI checks the membership).
import { forwardQuery, isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/questions'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  const query = forwardQuery(request, {
    document_id: UUID,
    limit: /^\d{1,3}$/,
    cursor: /^[A-Za-z0-9_-]{1,500}$/,
  });
  // Only the document-scoped list is relayed (the bank page reads its list server-side).
  if (query === null || !new URL(request.url).searchParams.has('document_id')) {
    return problemResponse(400, 'Bad Request', 'Malformed query.');
  }
  return relayToApi(`/workspaces/${workspaceId}/questions${query}`, { method: 'GET' });
}
