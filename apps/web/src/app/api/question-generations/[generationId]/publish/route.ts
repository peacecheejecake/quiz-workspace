// QGEN-01 relay: register approved variant drafts at the versions that were approved. FastAPI
// makes it idempotent per draft, so a retry after a lost response registers nothing twice.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

/** At most 200 `{draft_id, version}` items. */
const MAX_PUBLISH_BODY_BYTES = 64 * 1024;

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/question-generations/[generationId]/publish'>,
) {
  const { generationId } = await ctx.params;
  if (!isUuid(generationId)) return notFound();
  return relayToApi(`/question-generations/${generationId}/publish`, {
    method: 'POST',
    body: request,
    maxBodyBytes: MAX_PUBLISH_BODY_BYTES,
  });
}
