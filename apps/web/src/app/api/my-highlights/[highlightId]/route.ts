// HILITE-01 relay: change the color of (PATCH `{color, version}`) or delete (DELETE) one of the
// reader's own highlights. Another user's id answers like an unknown one (404, FastAPI).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  ctx: RouteContext<'/api/my-highlights/[highlightId]'>,
) {
  const { highlightId } = await ctx.params;
  if (!isUuid(highlightId)) return notFound();
  return relayToApi(`/my-highlights/${highlightId}`, { method: 'PATCH', body: request });
}

export async function DELETE(
  _request: Request,
  ctx: RouteContext<'/api/my-highlights/[highlightId]'>,
) {
  const { highlightId } = await ctx.params;
  if (!isUuid(highlightId)) return notFound();
  return relayToApi(`/my-highlights/${highlightId}`, { method: 'DELETE' });
}
