// DOC-01 relay: upload-intent (answers with the short-lived signed Storage upload URL).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/documents/upload-intent'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/documents/upload-intent`, {
    method: 'POST',
    body: request,
  });
}
