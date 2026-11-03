// RELSRC-01-C07 relay: a mock exam question's own 관련 본문 list (never the source question's).
// The gate (the caller's submitted mock practice session or `view: manage`) travels in the query.
import { EXPLANATION_QUERY } from '@/lib/ai-explanations/bff';
import { forwardQuery, isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/mock-exam-questions/[questionId]/related-sources'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  const query = forwardQuery(request, EXPLANATION_QUERY.mock);
  if (query === null) return problemResponse(400, 'Bad Request', 'Invalid query parameters.');
  return relayToApi(`/mock-exam-questions/${questionId}/related-sources${query}`, {
    method: 'GET',
  });
}
