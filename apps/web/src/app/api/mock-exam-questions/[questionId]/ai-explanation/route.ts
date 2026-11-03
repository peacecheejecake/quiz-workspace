// AIEXPL-01-C09 relay: a mock exam question's own AI explanation (never the source question's) —
// its state (GET, the gate in the query) and making it (POST, the gate in the body). FastAPI
// decides the gate (the caller's submitted mock practice session or `view: manage`).
import { EXPLANATION_QUERY } from '@/lib/ai-explanations/bff';
import { forwardQuery, isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/mock-exam-questions/[questionId]/ai-explanation'>;

export async function GET(request: Request, ctx: Ctx) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  const query = forwardQuery(request, EXPLANATION_QUERY.mock);
  if (query === null) return problemResponse(400, 'Bad Request', 'Invalid query parameters.');
  return relayToApi(`/mock-exam-questions/${questionId}/ai-explanation${query}`, {
    method: 'GET',
  });
}

export async function POST(request: Request, ctx: Ctx) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/mock-exam-questions/${questionId}/ai-explanation`, {
    method: 'POST',
    body: request,
  });
}
