// QSRC-01-C04 relay: a mock exam question's region (its origin question's, 보기 섞기 only).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/mock-exam-questions/[questionId]/source-region'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/mock-exam-questions/${questionId}/source-region`, { method: 'GET' });
}
