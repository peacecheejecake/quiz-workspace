// QIMPORT-01 relay (QIMP-JOB): hand the whole selection to the server, which approves and
// registers it in a job. FastAPI records it idempotently (`Idempotency-Key`), so a retry after a
// lost response starts nothing twice.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

/** At most 5000 `{draft_id, version}` items (~90 bytes each). */
const MAX_REGISTRATION_BODY_BYTES = 512 * 1024;

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/question-imports/[importId]/registrations'>,
) {
  const { importId } = await ctx.params;
  if (!isUuid(importId)) return notFound();
  return relayToApi(`/question-imports/${importId}/registrations`, {
    method: 'POST',
    body: request,
    maxBodyBytes: MAX_REGISTRATION_BODY_BYTES,
    idempotencyFrom: request,
  });
}
