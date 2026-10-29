// CHNOTE-01 relay: the workspace's chapters with a note (latest version, stale, generating) for
// the Heatmap headers' "만드는 중". FastAPI answers 404 for unknown/foreign workspaces.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/chapter-notes'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/chapter-notes`, { method: 'GET' });
}
