// MOCK-01 relay: a mock exam question's 편집 (PATCH: a new revision on `base_revision_id`) and
// 이 모의고사에서 빼기 (DELETE: taken out of the mock exam, its attempts kept). Editors of an
// active workspace; FastAPI checks the mock exam's workspace.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

/** A stem and explanation of up to 20,000 characters and up to 50 options of 5,000 each. */
const MAX_EDIT_BODY_BYTES = 1024 * 1024;

export async function PATCH(
  request: Request,
  ctx: RouteContext<'/api/mock-exam-questions/[questionId]'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/mock-exam-questions/${questionId}`, {
    method: 'PATCH',
    body: request,
    maxBodyBytes: MAX_EDIT_BODY_BYTES,
  });
}

export async function DELETE(
  _request: Request,
  ctx: RouteContext<'/api/mock-exam-questions/[questionId]'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/mock-exam-questions/${questionId}`, { method: 'DELETE' });
}
