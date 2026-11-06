// UX12-RESUME relay: the viewer's unfinished bank runs in the mock exam list. FastAPI checks the
// membership and answers only the caller's own runs, with no question content.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/practice-runs/unfinished'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/practice-runs/unfinished`, { method: 'GET' });
}
