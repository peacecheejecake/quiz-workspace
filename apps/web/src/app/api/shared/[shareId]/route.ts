// WS-VIEW-01 relay: the shared workspace (name, fork policy, published documents).
import { relayShared } from '@/lib/shared/bff';
import { relayContext } from '@/lib/shared/context';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: RouteContext<'/api/shared/[shareId]'>) {
  const { shareId } = await ctx.params;
  return relayShared(request, shareId, '', relayContext(request));
}
