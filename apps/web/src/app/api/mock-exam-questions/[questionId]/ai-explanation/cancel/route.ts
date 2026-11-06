// UX12-EXPLCANCEL relay: `취소` of a mock exam question's AI explanation being made.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/mock-exam-questions/[questionId]/ai-explanation/cancel'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/mock-exam-questions/${questionId}/ai-explanation/cancel`, {
    method: 'POST',
    body: request,
  });
}
