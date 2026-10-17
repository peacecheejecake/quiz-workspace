// QIMPORT-01 relay: one import run (status, current job, counts).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/question-imports/[importId]'>,
) {
  const { importId } = await ctx.params;
  if (!isUuid(importId)) return notFound();
  return relayToApi(`/question-imports/${importId}`, { method: 'GET' });
}
