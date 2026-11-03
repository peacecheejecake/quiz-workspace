// CHNOTE-02 relay: a note footnote's question preview (stem and options, never answers or
// explanations). FastAPI checks membership and that the question is a live CONFIRMED one; reading
// it records no view.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/questions/[questionId]/preview'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/questions/${questionId}/preview`, { method: 'GET' });
}
