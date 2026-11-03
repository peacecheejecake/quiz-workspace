// ASK-01 relay: the caller's own conversations of a workspace (GET, `?cursor=` pages) and a new
// conversation (POST {scope?, attachment?}). Questions and answers pass through unchanged and are
// never logged; FastAPI decides who may read or create.
import { forwardQuery, isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

const LIST_QUERY = { cursor: /^[\w:.+|-]{1,200}$/ } as const;
/** Scope ids (at most 200 + 200 uuids) and an attachment. */
const MAX_CREATE_BODY_BYTES = 32 * 1024;

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/ask/conversations'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  const query = forwardQuery(request, LIST_QUERY);
  if (query === null) return problemResponse(400, 'Bad Request', 'Malformed cursor.');
  return relayToApi(`/workspaces/${workspaceId}/ask/conversations${query}`, { method: 'GET' });
}

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/ask/conversations'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/ask/conversations`, {
    method: 'POST',
    body: request,
    maxBodyBytes: MAX_CREATE_BODY_BYTES,
  });
}
