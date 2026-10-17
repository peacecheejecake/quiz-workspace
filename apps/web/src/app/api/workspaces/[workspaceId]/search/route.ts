// SEARCH-01 relay: workspace search. FastAPI enforces membership, the published-revision scope and
// the per-user rate limit (a 429 keeps its `Retry-After`).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

/** Query (≤ 4000 characters, up to 4 bytes each) plus up to 200 document and 200 chapter ids. */
const MAX_SEARCH_BODY_BYTES = 64 * 1024;

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/search'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/search`, {
    method: 'POST',
    body: request,
    maxBodyBytes: MAX_SEARCH_BODY_BYTES,
  });
}
