// DOC-02 relay: canonical blocks of a revision, keyset-paged (`?revision=&after=&limit=`).
import {
  forwardQuery,
  isUuid,
  notFound,
  problemResponse,
  relayToApi,
  REVISION_SELECTOR,
} from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

const INTEGER = /^-?\d{1,9}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/documents/[documentId]/blocks'>,
) {
  const { documentId } = await ctx.params;
  if (!isUuid(documentId)) return notFound();
  const query = forwardQuery(request, {
    revision: REVISION_SELECTOR,
    chapter: UUID,
    page: INTEGER,
    after: INTEGER,
    limit: INTEGER,
  });
  if (query === null) return problemResponse(400, 'Bad Request', 'Invalid query parameters.');
  return relayToApi(`/documents/${documentId}/blocks${query}`, { method: 'GET' });
}
