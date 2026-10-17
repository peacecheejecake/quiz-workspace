// WS-VIEW-01 relay: search over the shared workspace's published documents.
import { relayShared } from '@/lib/shared/bff';
import { relayContext } from '@/lib/shared/context';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: RouteContext<'/api/shared/[shareId]/search'>) {
  const { shareId } = await ctx.params;
  return relayShared(request, shareId, '/search', relayContext(request), {
    method: 'POST',
    body: request,
  });
}
