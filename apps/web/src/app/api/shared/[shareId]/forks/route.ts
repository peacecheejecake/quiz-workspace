// WS-FORK-01 relay: start a fork of the shared workspace with the share session cookie and the
// user's verified Bearer token (src/lib/shared/bff.ts).
import { verifiedAccessToken } from '@/lib/api/server';
import { relayForkStart } from '@/lib/shared/bff';
import { relayContext } from '@/lib/shared/context';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: RouteContext<'/api/shared/[shareId]/forks'>) {
  const { shareId } = await ctx.params;
  const token = await verifiedAccessToken(await createSupabaseServerClient());
  return relayForkStart(request, shareId, relayContext(request), token);
}
