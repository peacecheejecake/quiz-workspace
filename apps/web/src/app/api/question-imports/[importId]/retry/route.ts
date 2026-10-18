// QIMPORT-01 relay: run a failed import again as a new job of the same run (no body).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/question-imports/[importId]/retry'>,
) {
  const { importId } = await ctx.params;
  if (!isUuid(importId)) return notFound();
  return relayToApi(`/question-imports/${importId}/retry`, {
    method: 'POST',
    idempotencyFrom: request,
  });
}
