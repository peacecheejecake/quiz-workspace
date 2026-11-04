// HILITE-01 relay (read): the signed-in reader's own highlights of a chapter — its note versions'
// highlights and its questions' explanation highlights. FastAPI checks membership; nobody else's
// highlights are ever returned.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/chapters/[chapterId]/my-highlights'>,
) {
  const { chapterId } = await ctx.params;
  if (!isUuid(chapterId)) return notFound();
  return relayToApi(`/chapters/${chapterId}/my-highlights`, { method: 'GET' });
}
