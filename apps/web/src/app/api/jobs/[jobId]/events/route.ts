// DOC-01 relay: job progress as Server-Sent Events, streamed through unchanged. The upstream
// request carries the Bearer token (fetch streaming) and ends when the browser disconnects.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: RouteContext<'/api/jobs/[jobId]/events'>) {
  const { jobId } = await ctx.params;
  if (!isUuid(jobId)) return notFound();
  return relayToApi(`/jobs/${jobId}/events`, {
    method: 'GET',
    stream: true,
    signal: request.signal,
  });
}
