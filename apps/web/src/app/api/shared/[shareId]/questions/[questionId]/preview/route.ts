// CHNOTE-02 relay: a shared note footnote's question preview (stem and options only) for a
// question in the share's published scope.
import { isUuid, relayShared, sharedProblem } from '@/lib/shared/bff';
import { relayContext } from '@/lib/shared/context';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/shared/[shareId]/questions/[questionId]/preview'>,
) {
  const { shareId, questionId } = await ctx.params;
  if (!isUuid(questionId)) return sharedProblem(404, 'Not Found');
  return relayShared(request, shareId, `/questions/${questionId}/preview`, relayContext(request));
}
