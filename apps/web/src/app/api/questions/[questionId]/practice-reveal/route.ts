// UX12-SOLVEDOPEN relay: `해설 보기`. FastAPI returns the caller's latest submission and closes
// their open sessions of the question in one transaction.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  ctx: RouteContext<'/api/questions/[questionId]/practice-reveal'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/questions/${questionId}/practice-reveal`, { method: 'POST' });
}
