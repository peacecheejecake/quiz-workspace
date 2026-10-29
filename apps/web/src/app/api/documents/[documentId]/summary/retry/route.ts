// DOCSUM-01 relay: `다시 시도` of the current revision's failed summary run (owner/editor, a new run
// of the same revision). The browser's Idempotency-Key is forwarded.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/documents/[documentId]/summary/retry'>,
) {
  const { documentId } = await ctx.params;
  if (!isUuid(documentId)) return notFound();
  return relayToApi(`/documents/${documentId}/summary/retry`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
  });
}
