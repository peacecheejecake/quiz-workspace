// CHREDIST-01 relay: `자동 추천 보기` (CHAPTER-MAP recommendations, read-only). FastAPI checks the
// membership (editors of an active workspace) and writes nothing.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

/** `{question_ids | all, include_manual}`: at most 5,000 ids (≈ 200 KB). */
const MAX_PREVIEW_BODY_BYTES = 256 * 1024;

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/chapter-redistribution/preview'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  return relayToApi(`/workspaces/${workspaceId}/chapter-redistribution/preview`, {
    method: 'POST',
    body: request,
    maxBodyBytes: MAX_PREVIEW_BODY_BYTES,
  });
}
