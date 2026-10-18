// DOC-02 relay: rollback — copy a published revision into the draft (editor+).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export async function POST(
  _request: Request,
  ctx: RouteContext<'/api/documents/[documentId]/revisions/[revisionId]/restore'>,
) {
  const { documentId, revisionId } = await ctx.params;
  if (!isUuid(documentId) || !isUuid(revisionId)) return notFound();
  return relayToApi(`/documents/${documentId}/revisions/${revisionId}/restore`, {
    method: 'POST',
  });
}
