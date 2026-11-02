// QVIEW-01 relay: start a practice run of a range (`시작`, `처음부터 다시`). FastAPI resolves the
// range (this workspace's live CONFIRMED questions only, the caller's study state) and checks the
// membership; the browser's Idempotency-Key makes a retried start yield the same run.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

/** `{source, range, random_order}`: a range lists at most 5,000 question ids (≈ 200 KB). */
const MAX_RUN_BODY_BYTES = 256 * 1024;

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/practice-runs'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/practice-runs`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
    maxBodyBytes: MAX_RUN_BODY_BYTES,
  });
}
