// WS-FORK-01 relay: status of one of the caller's forks (polled by the Fork dialog). Fork jobs are
// not visible through /jobs; this is their only status route, and only for the user who forked.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: RouteContext<'/api/me/forks/[forkId]'>) {
  const { forkId } = await ctx.params;
  if (!isUuid(forkId)) return notFound();
  return relayToApi(`/me/forks/${forkId}`, { method: 'GET' });
}
