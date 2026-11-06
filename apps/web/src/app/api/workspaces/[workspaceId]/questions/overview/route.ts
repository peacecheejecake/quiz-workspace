// QOV-01 / QVIEW-01 / QSEARCH-CACHE relay: the Heatmap's questions under its filters
// (`chapter`, `q`, repeatable `type` and `status`, `favorite`, `retry`). Previews only, never an
// answer; reading it records nothing. FastAPI checks the membership and judges the study state.
import { isUuid, notFound, problemResponse, relayToApi } from '@/lib/documents/bff';
import { NO_CHAPTER, OVERVIEW_SEARCH_MAX } from '@/lib/questions/overview-filters';

export const dynamic = 'force-dynamic';

const STATUSES = new Set(['unseen', 'viewed', 'incorrect', 'correct', 'retry', 'none']);
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
  const chapter = incoming.get('chapter');
  if (chapter !== null) {
    if (chapter !== NO_CHAPTER && !isUuid(chapter)) {
      return problemResponse(400, 'Bad Request', 'Malformed query.');
    }
    out.set('chapter', chapter === NO_CHAPTER ? NO_CHAPTER : chapter.toLowerCase());
  }
  const types = incoming.getAll('type');
  if (types.length > TYPES.size || !types.every((type) => TYPES.has(type))) {
    return problemResponse(400, 'Bad Request', 'Malformed query.');
  }
  for (const type of new Set(types)) out.append('type', type);
  const q = incoming.get('q');
  if (q !== null) {
    const trimmed = q.trim();
    if (trimmed.length === 0 || trimmed.length > OVERVIEW_SEARCH_MAX) {
      return problemResponse(400, 'Bad Request', 'Malformed query.');
    }
    out.set('q', trimmed);
  }
  const statuses = incoming.getAll('status');
  if (
    statuses.length > 5 ||
    !statuses.every((s) => STATUSES.has(s)) ||
    (statuses.includes('none') && statuses.length !== 1)
  ) {
    return problemResponse(400, 'Bad Request', 'Malformed query.');
  }
  for (const status of new Set(statuses)) out.append('status', status);
  for (const flag of ['favorite', 'retry']) {
    const value = incoming.get(flag);
    if (value === null) continue;
    if (!FLAG.test(value)) return problemResponse(400, 'Bad Request', 'Malformed query.');
    out.set(flag, value);
  }
  const query = out.toString();
  return relayToApi(`/workspaces/${workspaceId}/questions/overview${query ? `?${query}` : ''}`, {
    method: 'GET',
    signal: request.signal,
  });
}
