// UX12-CHAPTERADD relay: Workspace 챕터 이동. FastAPI compares `expected_version` under the tree lock.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/chapters/tree'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/chapters/tree`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
  });
}
