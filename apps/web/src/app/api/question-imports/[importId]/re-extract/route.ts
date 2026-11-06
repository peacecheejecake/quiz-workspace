// UX12-REEXTRACT relay: read the run's revision again as a new run with fresh drafts (no body).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/question-imports/[importId]/re-extract'>,
) {
  const { importId } = await ctx.params;
  if (!isUuid(importId)) return notFound();
  return relayToApi(`/question-imports/${importId}/re-extract`, {
    method: 'POST',
    idempotencyFrom: request,
  });
}
