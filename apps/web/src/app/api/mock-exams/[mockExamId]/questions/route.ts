// MOCK-01 relay: the questions a mock exam shows now. `include=answers` returns the answers and
// explanations to editors only; FastAPI never sends them to a viewer (MOCK-01-C05).
import { forwardQuery, isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/mock-exams/[mockExamId]/questions'>,
) {
  const { mockExamId } = await ctx.params;
  if (!isUuid(mockExamId)) return notFound();
  const query = forwardQuery(request, { include: /^answers$/ });
  if (query === null) return problemResponse(400, 'Bad Request', 'Malformed query.');
  return relayToApi(`/mock-exams/${mockExamId}/questions${query}`, { method: 'GET' });
}
