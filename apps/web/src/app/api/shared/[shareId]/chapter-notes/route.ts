// WS-VIEW-01 / CHNOTE-01 relay: the chapters whose newest note matches its source questions.
import { relayShared } from '@/lib/shared/bff';
import { relayContext } from '@/lib/shared/context';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/shared/[shareId]/chapter-notes'>,
) {
  const { shareId } = await ctx.params;
  return relayShared(request, shareId, '/chapter-notes', relayContext(request));
}
