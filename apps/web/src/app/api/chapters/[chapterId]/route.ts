// CHMAN-01 relay: 이름 바꾸기 and 삭제. `move_questions_to` is a chapter id or `none`.
import { isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, ctx: RouteContext<'/api/chapters/[chapterId]'>) {
  const { chapterId } = await ctx.params;
  if (!isUuid(chapterId)) return notFound();
  return relayToApi(`/chapters/${chapterId}`, {
    method: 'PATCH',
    body: request,
    idempotencyFrom: request,
  });
}

export async function DELETE(request: Request, ctx: RouteContext<'/api/chapters/[chapterId]'>) {
  const { chapterId } = await ctx.params;
  if (!isUuid(chapterId)) return notFound();
  const target = new URL(request.url).searchParams.get('move_questions_to');
  if (target !== null && target !== 'none' && !isUuid(target)) {
    return problemResponse(400, 'Bad Request', 'Malformed move_questions_to.');
  }
  const query = target === null ? '' : `?move_questions_to=${encodeURIComponent(target)}`;
  return relayToApi(`/chapters/${chapterId}${query}`, {
    method: 'DELETE',
    idempotencyFrom: request,
  });
}
