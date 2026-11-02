// CHREDIST-01 relay: the 챕터 재분배 dialog's list (the workspace's confirmed questions by chapter
// group and the chapters they may move to). FastAPI checks the membership (editors of an active
// workspace); the list carries no answers.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/chapter-redistribution/questions'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/chapter-redistribution/questions`, {
    method: 'GET',
  });
}
