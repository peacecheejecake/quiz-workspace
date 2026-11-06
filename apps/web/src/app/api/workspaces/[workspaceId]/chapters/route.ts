// CHMAN-01 relay: 챕터 추가. The browser's Idempotency-Key makes a retried press add one chapter.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/chapters'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/chapters`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
  });
}
