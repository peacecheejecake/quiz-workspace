// MOCK-P relay: open a mock exam question at a position of the caller's mock run (QuestionViewer
// sequence, `source=mock`): the answer-free question in its displayed order. Nothing is recorded
// outside the mock exam tables (MOCK-01-C01).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/mock-exam-questions/[questionId]/practice-sessions'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/mock-exam-questions/${questionId}/practice-sessions`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
  });
}
