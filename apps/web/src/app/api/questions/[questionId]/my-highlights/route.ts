// HILITE-01 relay (read): the reader's own highlights of a question's explanation, read only once
// the explanation is on screen (after a submission, or in 문제 상세). The response holds the
// reader's quotes only, never the explanation.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/questions/[questionId]/my-highlights'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/questions/${questionId}/my-highlights`, { method: 'GET' });
}
