// CHNOTE-01 relay: a chapter's 정리 노트 state (`?version=k` for an older version) and creating a
// new version. The browser's Idempotency-Key makes a double press or a retried request after a
// lost response yield the same generation. FastAPI checks membership, role, archived workspace
// and the feature switch.
import { forwardQuery, isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

const NOTE_QUERY = { version: /^[1-9][0-9]{0,5}$/ } as const;

export async function GET(request: Request, ctx: RouteContext<'/api/chapters/[chapterId]/note'>) {
  const { chapterId } = await ctx.params;
  if (!isUuid(chapterId)) return notFound();
  const query = forwardQuery(request, NOTE_QUERY);
  if (query === null) return problemResponse(400, 'Bad Request', 'Malformed query.');
  return relayToApi(`/chapters/${chapterId}/note${query}`, { method: 'GET' });
}

export async function POST(request: Request, ctx: RouteContext<'/api/chapters/[chapterId]/note'>) {
  const { chapterId } = await ctx.params;
  if (!isUuid(chapterId)) return notFound();
  return relayToApi(`/chapters/${chapterId}/note`, { method: 'POST', idempotencyFrom: request });
}
