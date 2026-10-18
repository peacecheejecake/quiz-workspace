// WS-VIEW-01 relay: exchange the share-link secret (sent once in the body, from the URL fragment)
// for this origin's HttpOnly share session cookie. See src/lib/shared/bff.ts.
import { exchangeSession } from '@/lib/shared/bff';
import { relayContext } from '@/lib/shared/context';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: RouteContext<'/api/shared/[shareId]/sessions'>) {
  const { shareId } = await ctx.params;
  return exchangeSession(request, shareId, relayContext(request));
}
