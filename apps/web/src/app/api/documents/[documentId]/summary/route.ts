// DOCSUM-01 relay: the summary panel's state (GET, any member) and `요약 만들기` (POST, owner/editor;
// the browser's Idempotency-Key is forwarded so a double press is one run). Summary text passes
// through unchanged and is never logged; FastAPI decides who may read or create.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/documents/[documentId]/summary'>,
) {
  const { documentId } = await ctx.params;
  if (!isUuid(documentId)) return notFound();
  return relayToApi(`/documents/${documentId}/summary`, { method: 'GET' });
}

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/documents/[documentId]/summary'>,
) {
  const { documentId } = await ctx.params;
  if (!isUuid(documentId)) return notFound();
  return relayToApi(`/documents/${documentId}/summary`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
  });
}
