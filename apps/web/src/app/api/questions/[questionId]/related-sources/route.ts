// RELSRC-01 relay: a question's stored-or-computed 관련 본문 list. The gate (the caller's submitted
// practice session or `view: detail`) travels in the query; FastAPI decides it and computes
// nothing before a submission.
import { EXPLANATION_QUERY } from '@/lib/ai-explanations/bff';
import { forwardQuery, isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/questions/[questionId]/related-sources'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  const query = forwardQuery(request, EXPLANATION_QUERY.question);
  if (query === null) return problemResponse(400, 'Bad Request', 'Invalid query parameters.');
  return relayToApi(`/questions/${questionId}/related-sources${query}`, { method: 'GET' });
}
