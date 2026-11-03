// AIEXPL-01 / WS-VIEW-01 relay: the AI explanation a member already made for one published
// question (read-only; a guest never makes one).
import { isUuid, relayShared, sharedProblem } from '@/lib/shared/bff';
import { relayContext } from '@/lib/shared/context';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/shared/[shareId]/questions/[questionId]/ai-explanation'>,
) {
  const { shareId, questionId } = await ctx.params;
  if (!isUuid(questionId)) return sharedProblem(404, 'Not Found');
  return relayShared(
    request,
    shareId,
    `/questions/${questionId}/ai-explanation`,
    relayContext(request),
  );
}
