// CHREDIST-01 relay: `옮기기` / `선택한 추천 적용` (one atomic move). FastAPI checks the membership,
// that every question still has the chapter the dialog showed (409 chapter-changed otherwise) and
// the targets; the browser's Idempotency-Key makes a retried press move once.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

/** `{source, items}`: at most 5,000 items of three ids each (≈ 600 KB). */
const MAX_ASSIGN_BODY_BYTES = 1024 * 1024;

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/questions/chapter-assignments'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/questions/chapter-assignments`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
    maxBodyBytes: MAX_ASSIGN_BODY_BYTES,
  });
}
