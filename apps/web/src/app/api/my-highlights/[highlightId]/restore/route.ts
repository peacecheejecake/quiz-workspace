// HILITE-01 relay: `되돌리기` of a deleted highlight (same id, place and color; 10 minutes).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  ctx: RouteContext<'/api/my-highlights/[highlightId]/restore'>,
) {
  const { highlightId } = await ctx.params;
  if (!isUuid(highlightId)) return notFound();
  return relayToApi(`/my-highlights/${highlightId}/restore`, { method: 'POST' });
}
