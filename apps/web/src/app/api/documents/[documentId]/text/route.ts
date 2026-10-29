// DOC-03 relay: the document's full text as a Markdown or text file (`?format=md|txt`,
// `?revision=published|draft|<revision id>`). The body and its attachment name pass through unchanged and are
// never logged; FastAPI decides who may export which revision.
import { forwardQuery, isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: RouteContext<'/api/documents/[documentId]/text'>) {
  const { documentId } = await ctx.params;
  if (!isUuid(documentId)) return notFound();
  const query = forwardQuery(request, {
    format: /^(md|txt)$/,
    revision: /^(published|draft|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  });
  if (query === null) return problemResponse(400, 'Bad Request', 'Invalid query parameters.');
  return relayToApi(`/documents/${documentId}/text${query}`, { method: 'GET', attachment: true });
}
