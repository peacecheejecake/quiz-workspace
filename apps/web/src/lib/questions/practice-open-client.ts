// Browser side of the panel's one opening call (UX12-OPEN, docs/screens/ux12-question-open.md). It
// goes to this app's route handler (lib/documents/bff.ts), like practice-run-client.ts, so it does
// not wait in Next's server action queue. FastAPI decides everything: reuse, the latest result, a
// new session, and that answers appear only under `result`.
import type { Schemas } from '@quiz/api-client';
import { loginRedirectPath } from '@/lib/auth/routes';
import { isWorkspaceId } from '@/lib/workspaces/validation';
import type { StudyActionResult } from './practice-actions';
import {
  classifyQuestionFailure,
  QUESTION_FAILURE_MESSAGES,
  type QuestionFailureKind,
} from './problems';

export type PracticeOpened = Schemas['PracticeOpened'];

export interface PracticeOpenRequest {
  /** The open session kept in memory, with the latest attempt known when it was opened. */
  readonly cached?: { readonly sessionId: string; readonly baselineAttemptId: string | null };
  /** Another try: a new session, whatever the latest result is. */
  readonly forceNew?: boolean;
}

function failed<T>(kind: QuestionFailureKind): StudyActionResult<T> {
  return { ok: false, kind, message: QUESTION_FAILURE_MESSAGES[kind] };
}

export function practiceOpenPath(questionId: string): string {
  return `/api/questions/${encodeURIComponent(questionId)}/practice-open`;
}

/** `key` is minted once per panel opening, so a repeated request opens one session. */
export async function openQuestionPractice(
  workspaceId: string,
  questionId: string,
  key: string,
  request: PracticeOpenRequest = {},
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<StudyActionResult<PracticeOpened>> {
  if (!isWorkspaceId(workspaceId) || !isWorkspaceId(questionId)) return failed('notFound');
  let response: Response;
  try {
    response = await fetchImpl(practiceOpenPath(questionId), {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({
        ...(request.cached
          ? {
              cached_session_id: request.cached.sessionId,
              baseline_attempt_id: request.cached.baselineAttemptId,
            }
          : {}),
        ...(request.forceNew ? { force_new: true } : {}),
      }),
    });
  } catch {
    return failed('unavailable');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.ok) return failed('unavailable');
    body = undefined;
  }
  if (!response.ok) {
    const { kind } = classifyQuestionFailure(response.status, body);
    if (kind === 'unauthenticated') {
      window.location.assign(loginRedirectPath(`/workspaces/${workspaceId}`));
    }
    return failed(kind);
  }
  const data = body as PracticeOpened;
  const owner = (data.session ?? data.result)?.workspace_id;
  return owner?.toLowerCase() === workspaceId.toLowerCase()
    ? { ok: true, data }
    : failed('notFound');
}
