// MOCK-P relay: the user's own grade of a pending mock practice submission (once).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/mock-practice-sessions/[sessionId]/self-grade'>,
) {
  const { sessionId } = await ctx.params;
  if (!isUuid(sessionId)) return notFound();
  return relayToApi(`/mock-practice-sessions/${sessionId}/self-grade`, {
    method: 'POST',
    body: request,
  });
}
