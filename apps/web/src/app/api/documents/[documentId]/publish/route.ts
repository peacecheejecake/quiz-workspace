// DOC-02 relay: publish the correction draft (202 + indexing job). The browser's Idempotency-Key
// is forwarded so a retried request replays the first answer.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/documents/[documentId]/publish'>,
) {
  const { documentId } = await ctx.params;
  if (!isUuid(documentId)) return notFound();
  return relayToApi(`/documents/${documentId}/publish`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
  });
}
