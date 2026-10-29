// DOCSUM-01 / WS-VIEW-01 relay: the current published revision's summary of a shared document
// (read-only; FastAPI answers the share API's one 404 for anything else).
import { isUuid, relayShared, sharedProblem } from '@/lib/shared/bff';
import { relayContext } from '@/lib/shared/context';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/shared/[shareId]/documents/[documentId]/summary'>,
) {
  const { shareId, documentId } = await ctx.params;
  if (!isUuid(documentId)) return sharedProblem(404, 'Not Found');
  return relayShared(request, shareId, `/documents/${documentId}/summary`, relayContext(request));
}
