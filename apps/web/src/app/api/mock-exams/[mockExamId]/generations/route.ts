// MOCK-01 relay: a new round of a mock exam — 설정 바꾸기 ({config, range}), 다시 만들기 and
// 다시 시도 (an empty body). Editors of an active workspace; one running round per mock exam.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

/** `{config, range}`: a range lists at most 5,000 question ids (≈ 200 KB). */
const MAX_GENERATION_BODY_BYTES = 256 * 1024;

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/mock-exams/[mockExamId]/generations'>,
) {
  const { mockExamId } = await ctx.params;
  if (!isUuid(mockExamId)) return notFound();
  return relayToApi(`/mock-exams/${mockExamId}/generations`, {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
    maxBodyBytes: MAX_GENERATION_BODY_BYTES,
  });
}
