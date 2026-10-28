// DOC-01/DOC-02 relay: document detail (status, active/latest revision), `종류 변경` (PATCH, UX6-
// UPLOAD) and soft delete (editor+, decided by the API).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: RouteContext<'/api/documents/[documentId]'>) {
  const { documentId } = await ctx.params;
  if (!isUuid(documentId)) return notFound();
  return relayToApi(`/documents/${documentId}`, { method: 'GET' });
}

export async function DELETE(_request: Request, ctx: RouteContext<'/api/documents/[documentId]'>) {
  const { documentId } = await ctx.params;
  if (!isUuid(documentId)) return notFound();
  return relayToApi(`/documents/${documentId}`, { method: 'DELETE' });
}

export async function PATCH(request: Request, ctx: RouteContext<'/api/documents/[documentId]'>) {
  const { documentId } = await ctx.params;
  if (!isUuid(documentId)) return notFound();
  return relayToApi(`/documents/${documentId}`, { method: 'PATCH', body: request });
}
