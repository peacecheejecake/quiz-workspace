import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/questions/[questionId]/practice-reset'>,
) {
  const { questionId } = await ctx.params;
  if (!isUuid(questionId)) return notFound();
  return relayToApi(`/questions/${questionId}/practice-reset`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
    maxBodyBytes: 1024,
  });
}
