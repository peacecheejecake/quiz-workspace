// DOC-02 relay: short-lived signed read URL of the original PDF for the viewer. The URL reaches
// the browser only in this no-store response; it is never logged or put into a page URL.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/documents/[documentId]/source-url'>,
) {
  const { documentId } = await ctx.params;
  if (!isUuid(documentId)) return notFound();
  return relayToApi(`/documents/${documentId}/source-url`, { method: 'GET' });
}
