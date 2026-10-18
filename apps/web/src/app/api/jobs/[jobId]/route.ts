// DOC-01 relay: job status (polling fallback of the event stream).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: RouteContext<'/api/jobs/[jobId]'>) {
  const { jobId } = await ctx.params;
  if (!isUuid(jobId)) return notFound();
  return relayToApi(`/jobs/${jobId}`, { method: 'GET' });
}
