// AIEXPL-01-C09 relay: a mock exam question's AI explanation stream (lib/http/sse-relay.ts).
import { EXPLANATION_QUERY } from '@/lib/ai-explanations/bff';
import { forwardQuery, isUuid, notFound, problemResponse } from '@/lib/documents/bff';
import { relaySse } from '@/lib/http/sse-relay';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/mock-ai-explanations/[explanationId]/stream'>,
) {
  const { explanationId } = await ctx.params;
  if (!isUuid(explanationId)) return notFound();
  const query = forwardQuery(request, EXPLANATION_QUERY.mock);
  if (query === null) return problemResponse(400, 'Bad Request', 'Invalid query parameters.');
  return relaySse(`/mock-ai-explanations/${explanationId}/stream${query}`, request);
}
