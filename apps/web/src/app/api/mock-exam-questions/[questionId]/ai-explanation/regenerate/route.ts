// AIEXPL-01-C09 relay: `다시 만들기` of a mock exam question's AI explanation (owner/editor).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/mock-exam-questions/[questionId]/ai-explanation/regenerate'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/mock-exam-questions/${questionId}/ai-explanation/regenerate`, {
    method: 'POST',
    body: request,
  });
}
