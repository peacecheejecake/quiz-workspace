// UX12-SHARE relay: the owner's attempts, on a link that opts in.
import { CURSOR_PARAM, INT_PARAM, relayShared, sharedProblem, sharedQuery } from '@/lib/shared/bff';
import { relayContext } from '@/lib/shared/context';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/shared/[shareId]/owner-attempts'>,
) {
  const { shareId } = await ctx.params;
  const query = sharedQuery(request, { limit: INT_PARAM, cursor: CURSOR_PARAM });
  if (query === null) return sharedProblem(400, 'Bad Request', 'Invalid query parameter.');
  return relayShared(request, shareId, '/owner-attempts', relayContext(request), { query });
}
