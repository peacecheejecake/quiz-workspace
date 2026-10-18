// WS-VIEW-01 relay: the shared workspace's published (CONFIRMED) questions.
import {
  CURSOR_PARAM,
  INT_PARAM,
  QUESTION_TYPE_PARAM,
  UUID_PARAM,
  relayShared,
  sharedProblem,
  sharedQuery,
} from '@/lib/shared/bff';
import { relayContext } from '@/lib/shared/context';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: RouteContext<'/api/shared/[shareId]/questions'>) {
  const { shareId } = await ctx.params;
  const query = sharedQuery(request, {
    question_type: QUESTION_TYPE_PARAM,
    chapter_id: UUID_PARAM,
    document_id: UUID_PARAM,
    limit: INT_PARAM,
    cursor: CURSOR_PARAM,
  });
  if (query === null) return sharedProblem(400, 'Bad Request', 'Invalid query parameter.');
  return relayShared(request, shareId, '/questions', relayContext(request), { query });
}
