// QIMPORT-01 relay: list the workspace's import runs (newest first; `document_id` narrows them to
// one question paper) / start (or attach to, QIMPORT-01-AC06) the import of a processed paper. A start carries the browser's Idempotency-Key, so a retried request
// after a lost response yields the same run.
import { forwardQuery, isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/question-imports'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  const query = forwardQuery(request, {
    limit: /^\d{1,3}$/,
    document_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  });
  if (query === null) return problemResponse(400, 'Bad Request', 'Malformed query.');
  return relayToApi(`/workspaces/${workspaceId}/question-imports${query}`, { method: 'GET' });
}

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/question-imports'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/question-imports`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
  });
}
