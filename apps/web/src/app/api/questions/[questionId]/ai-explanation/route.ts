// AIEXPL-01 relay: a question's AI explanation — its state (GET, the gate in the query) and making
// it (POST, the gate in the body). FastAPI decides the gate (the caller's submitted practice
// session or `view: detail`), the cache, the limits and who may make one.
import { EXPLANATION_QUERY } from '@/lib/ai-explanations/bff';
import { forwardQuery, isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/questions/[questionId]/ai-explanation'>;

export async function GET(request: Request, ctx: Ctx) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  const query = forwardQuery(request, EXPLANATION_QUERY.question);
  if (query === null) return problemResponse(400, 'Bad Request', 'Invalid query parameters.');
  return relayToApi(`/questions/${questionId}/ai-explanation${query}`, { method: 'GET' });
}

export async function POST(request: Request, ctx: Ctx) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/questions/${questionId}/ai-explanation`, { method: 'POST', body: request });
}
