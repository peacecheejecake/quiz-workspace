// MOCK-P relay: submit the answer of a mock practice session. FastAPI grades it by option ids on
// the session's revision and only now returns the answers and the explanation.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

/** An answer text of up to 20,000 characters or up to 50 option ids. */
const MAX_SUBMIT_BODY_BYTES = 128 * 1024;

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/mock-practice-sessions/[sessionId]/submit'>,
) {
  const { sessionId } = await ctx.params;
  if (!isUuid(sessionId)) return notFound();
  return relayToApi(`/mock-practice-sessions/${sessionId}/submit`, {
    method: 'POST',
    body: request,
    maxBodyBytes: MAX_SUBMIT_BODY_BYTES,
  });
}
