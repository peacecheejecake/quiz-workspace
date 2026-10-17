// DOC-02 relay: chapter/section tree of a revision (`?revision=active|latest|<id>`).
import {
  forwardQuery,
  isUuid,
  notFound,
  problemResponse,
  relayToApi,
  REVISION_SELECTOR,
} from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/documents/[documentId]/outline'>,
) {
  const { documentId } = await ctx.params;
  if (!isUuid(documentId)) return notFound();
  const query = forwardQuery(request, { revision: REVISION_SELECTOR });
  if (query === null) return problemResponse(400, 'Bad Request', 'Invalid query parameters.');
  return relayToApi(`/documents/${documentId}/outline${query}`, { method: 'GET' });
}
