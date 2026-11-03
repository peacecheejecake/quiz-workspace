// AIEXPL-01-C05 relay: an AI explanation's Server-Sent Events while it is written (the gate in the
// query, re-checked by FastAPI on every poll; lib/http/sse-relay.ts).
import { EXPLANATION_QUERY } from '@/lib/ai-explanations/bff';
import { forwardQuery, isUuid, notFound, problemResponse } from '@/lib/documents/bff';
import { relaySse } from '@/lib/http/sse-relay';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/ai-explanations/[explanationId]/stream'>,
) {
  const { explanationId } = await ctx.params;
  if (!isUuid(explanationId)) return notFound();
  const query = forwardQuery(request, EXPLANATION_QUERY.question);
  if (query === null) return problemResponse(400, 'Bad Request', 'Invalid query parameters.');
  return relaySse(`/ai-explanations/${explanationId}/stream${query}`, request);
}
