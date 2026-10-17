// WS-VIEW-01 relay: one published question with its answer and explanation (read-only).
import { isUuid, relayShared, sharedProblem } from '@/lib/shared/bff';
import { relayContext } from '@/lib/shared/context';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/shared/[shareId]/questions/[questionId]'>,
) {
  const { shareId, questionId } = await ctx.params;
  if (!isUuid(questionId)) return sharedProblem(404, 'Not Found');
  return relayShared(request, shareId, `/questions/${questionId}`, relayContext(request));
}
