// QVIEW-01 relay: the Heatmap's questions for the range step of a practice run, under its
// filters (repeatable `status`, `favorite`, `retry`, `type`). Previews only, never an answer;
// reading it records nothing. FastAPI checks the membership and judges the study state.
import { isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

const STATUSES = new Set(['unseen', 'viewed', 'incorrect', 'correct', 'retry']);
const TYPES = new Set(['MCQ', 'SHORT_ANSWER', 'ESSAY']);
const FLAG = /^(true|false)$/;

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/workspaces/[workspaceId]/questions/overview'>,
) {
  const { workspaceId } = await ctx.params;
  if (!isUuid(workspaceId)) return notFound();
  const incoming = new URL(request.url).searchParams;
  const out = new URLSearchParams();
  const statuses = incoming.getAll('status');
  if (statuses.length > STATUSES.size || !statuses.every((s) => STATUSES.has(s))) {
    return problemResponse(400, 'Bad Request', 'Malformed query.');
  }
  for (const status of new Set(statuses)) out.append('status', status);
  for (const flag of ['favorite', 'retry']) {
    const value = incoming.get(flag);
    if (value === null) continue;
    if (!FLAG.test(value)) return problemResponse(400, 'Bad Request', 'Malformed query.');
    out.set(flag, value);
  }
  const type = incoming.get('type');
  if (type !== null) {
    if (!TYPES.has(type)) return problemResponse(400, 'Bad Request', 'Malformed query.');
    out.set('type', type);
  }
  const query = out.toString();
  return relayToApi(`/workspaces/${workspaceId}/questions/overview${query ? `?${query}` : ''}`, {
    method: 'GET',
  });
}
