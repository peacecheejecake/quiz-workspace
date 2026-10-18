// QIMPORT-01 / QGEN-01 relay: edit, approve, reject or reopen one draft on top of the `version`
// the reviewer saw (FastAPI answers 409 stale-draft otherwise).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

/** Stem, explanation and rubric up to 20 000 characters, up to 50 options of 5 000 each. */
const MAX_DRAFT_BODY_BYTES = 1024 * 1024;

export async function PATCH(request: Request, ctx: RouteContext<'/api/question-drafts/[draftId]'>) {
  const { draftId } = await ctx.params;
  if (!isUuid(draftId)) return notFound();
  return relayToApi(`/question-drafts/${draftId}`, {
    method: 'PATCH',
    body: request,
    maxBodyBytes: MAX_DRAFT_BODY_BYTES,
  });
}
