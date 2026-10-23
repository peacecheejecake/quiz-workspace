// QIMPORT-01 relay (QIMP-JOB): progress of a server-side registration (processed/total, refused).
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/question-imports/[importId]/registrations/[jobId]'>,
) {
  const { importId, jobId } = await ctx.params;
  if (!isUuid(importId) || !isUuid(jobId)) return notFound();
  return relayToApi(`/question-imports/${importId}/registrations/${jobId}`, { method: 'GET' });
}
