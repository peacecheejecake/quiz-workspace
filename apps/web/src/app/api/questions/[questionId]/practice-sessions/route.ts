// QVIEW-01 relay: open (or resume) the practice session of a run position,
// `{practice_run_id, run_position}`. The server records the view and returns the question without
// answers; a submitted position is 409 `already-submitted`, an archived workspace 403. The
// practice panel's own sessions go through `practice-open` (UX12-OPEN).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

const MAX_SESSION_BODY_BYTES = 1024;

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/questions/[questionId]/practice-sessions'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/questions/${questionId}/practice-sessions`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
    maxBodyBytes: MAX_SESSION_BODY_BYTES,
  });
}
