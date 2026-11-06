// CHMAN-01 relay: 챕터 이동. FastAPI compares `expected_version` under the document lock.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/documents/[documentId]/chapters/tree'>,
) {
  const { documentId } = await ctx.params;
  if (!isUuid(documentId)) return notFound();
  return relayToApi(`/documents/${documentId}/chapters/tree`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
  });
}
