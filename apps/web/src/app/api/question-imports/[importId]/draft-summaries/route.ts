// QIMPORT-01 relay (QIMP-PAGING): every draft of the run without its content — what the review
// selects, counts and registers by; the content of the page on screen comes from `drafts`.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/question-imports/[importId]/draft-summaries'>,
) {
  const { importId } = await ctx.params;
  if (!isUuid(importId)) return notFound();
  return relayToApi(`/question-imports/${importId}/draft-summaries`, { method: 'GET' });
}
