// WS-VIEW-01 relay: the original PDF of a shared document, streamed (no signed Storage URL ever
// reaches the browser). Same-origin, so the PDF viewer can fetch it with the share cookie.
import { isUuid, relayShared, sharedProblem } from '@/lib/shared/bff';
import { relayContext } from '@/lib/shared/context';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/shared/[shareId]/documents/[documentId]/pdf'>,
) {
  const { shareId, documentId } = await ctx.params;
  if (!isUuid(documentId)) return sharedProblem(404, 'Not Found');
  return relayShared(request, shareId, `/documents/${documentId}/pdf`, relayContext(request), {
    stream: true,
    signal: request.signal,
  });
}
