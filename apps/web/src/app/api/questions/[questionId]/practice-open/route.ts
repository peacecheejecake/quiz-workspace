// UX12-OPEN relay: the practice panel's one opening call. FastAPI confirms the latest result and
// reuses or opens a session in one transaction; answers appear only in a submitted `result`.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

const MAX_OPEN_BODY_BYTES = 1024;

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/questions/[questionId]/practice-open'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/questions/${questionId}/practice-open`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
    maxBodyBytes: MAX_OPEN_BODY_BYTES,
    serverTiming: true,
  });
}
