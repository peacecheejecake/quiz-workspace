// RELSRC-01 / WS-VIEW-01 relay: the 관련 본문 list already stored for one published question
// (read-only; a guest request never computes one).
import { isUuid, relayShared, sharedProblem } from '@/lib/shared/bff';
import { relayContext } from '@/lib/shared/context';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/shared/[shareId]/questions/[questionId]/related-sources'>,
) {
  const { shareId, questionId } = await ctx.params;
  if (!isUuid(questionId)) return sharedProblem(404, 'Not Found');
  return relayShared(
    request,
    shareId,
    `/questions/${questionId}/related-sources`,
    relayContext(request),
  );
}
