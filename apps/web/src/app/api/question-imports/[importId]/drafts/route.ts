// QIMPORT-01 relay: the run's drafts in source order (also those a failed job persisted); with
// `offset`/`limit` one page of them (QIMP-PAGING), `include_chapters=false` without the chapter list.
import { forwardQuery, isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

const QUERY = {
  offset: /^\d{1,9}$/,
  limit: /^\d{1,3}$/,
  include_chapters: /^(true|false)$/,
} as const;

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/question-imports/[importId]/drafts'>,
) {
  const { importId } = await ctx.params;
  if (!isUuid(importId)) return notFound();
  const query = forwardQuery(request, QUERY);
  if (query === null) return problemResponse(400, 'Bad Request', 'Malformed query.');
  return relayToApi(`/question-imports/${importId}/drafts${query}`, { method: 'GET' });
}
