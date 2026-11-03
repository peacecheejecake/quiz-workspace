// QSRC-01 relay: where a question sits in its imported PDF (document id, page, bbox — never any
// question text or answer). A 404 means "no region" and hides the 문제 원문 보기 button.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/questions/[questionId]/source-region'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/questions/${questionId}/source-region`, { method: 'GET' });
}
