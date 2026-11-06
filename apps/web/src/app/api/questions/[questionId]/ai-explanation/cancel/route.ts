// UX12-EXPLCANCEL relay: `취소` of a question's AI explanation being made (its requester or an
// owner/editor of an active workspace; FastAPI decides).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/questions/[questionId]/ai-explanation/cancel'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/questions/${questionId}/ai-explanation/cancel`, {
    method: 'POST',
    body: request,
  });
}
