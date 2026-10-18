// WS-VIEW-01 relay: a shared document's published revision (outline + a page of blocks).
import { INT_PARAM, isUuid, relayShared, sharedProblem, sharedQuery } from '@/lib/shared/bff';
import { relayContext } from '@/lib/shared/context';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/shared/[shareId]/documents/[documentId]'>,
) {
  const { shareId, documentId } = await ctx.params;
  if (!isUuid(documentId)) return sharedProblem(404, 'Not Found');
  const query = sharedQuery(request, { page: INT_PARAM, after: INT_PARAM, limit: INT_PARAM });
  if (query === null) return sharedProblem(400, 'Bad Request', 'Invalid query parameter.');
  return relayShared(request, shareId, `/documents/${documentId}`, relayContext(request), {
    query,
  });
}
