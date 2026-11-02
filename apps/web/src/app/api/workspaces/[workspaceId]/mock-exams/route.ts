// MOCK-01 relay: a workspace's mock exams (any member, archived included) and 만들기 (editors of an
// active workspace). FastAPI checks the membership, resolves the range to this workspace's live
// CONFIRMED questions and enforces the limits; the browser's Idempotency-Key makes a retried
// 만들기 yield the same mock exam.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

/** `{title, config, range}`: a range lists at most 5,000 question ids (≈ 200 KB). */
const MAX_CREATE_BODY_BYTES = 256 * 1024;

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/mock-exams'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/mock-exams`, { method: 'GET' });
}

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/mock-exams'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/mock-exams`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
    maxBodyBytes: MAX_CREATE_BODY_BYTES,
  });
}
