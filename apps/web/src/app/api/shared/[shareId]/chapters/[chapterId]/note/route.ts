// WS-VIEW-01 / CHNOTE-01 relay: one chapter's newest note (read-only; 404 unless it matches its
// source questions).
import { isUuid, relayShared, sharedProblem } from '@/lib/shared/bff';
import { relayContext } from '@/lib/shared/context';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/shared/[shareId]/chapters/[chapterId]/note'>,
) {
  const { shareId, chapterId } = await ctx.params;
  if (!isUuid(chapterId)) return sharedProblem(404, 'Not Found');
  return relayShared(request, shareId, `/chapters/${chapterId}/note`, relayContext(request));
}
