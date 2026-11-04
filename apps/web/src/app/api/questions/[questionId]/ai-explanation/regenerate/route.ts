// AIEXPL-01 relay: `다시 만들기` — a new version of a question's AI explanation (owner/editor of an
// active workspace, a few times a day; FastAPI decides).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/questions/[questionId]/ai-explanation/regenerate'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/questions/${questionId}/ai-explanation/regenerate`, {
    method: 'POST',
    body: request,
  });
}
