// DOC-01 relay: soft-delete a document (editor+, decided by the API).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export async function DELETE(_request: Request, ctx: RouteContext<'/api/documents/[documentId]'>) {
  const { documentId } = await ctx.params;
  if (!isUuid(documentId)) return notFound();
  return relayToApi(`/documents/${documentId}`, { method: 'DELETE' });
}
