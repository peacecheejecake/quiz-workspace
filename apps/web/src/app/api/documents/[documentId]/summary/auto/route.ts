// DOCSUM-01 relay: `자동 갱신 끄기` (owner/editor of an active workspace; idempotent 204).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export async function DELETE(
  _request: Request,
  ctx: RouteContext<'/api/documents/[documentId]/summary/auto'>,
) {
  const { documentId } = await ctx.params;
  if (!isUuid(documentId)) return notFound();
  return relayToApi(`/documents/${documentId}/summary/auto`, { method: 'DELETE' });
}
