// ASK-01 relay: whether new AI questions can be asked in this workspace (`available`, `reason`,
// limits). FastAPI checks membership; a non-member gets its one 404.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/ask'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/ask`, { method: 'GET' });
}
