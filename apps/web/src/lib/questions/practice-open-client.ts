// Browser side of the panel's one opening call (UX12-OPEN, docs/screens/ux12-question-open.md). It
// goes to this app's route handler (lib/documents/bff.ts), like practice-run-client.ts, so it does
// not wait in Next's server action queue. FastAPI decides everything: reuse or a new session, and
// that answers appear only under `result` of a pending submission or a `해설 보기` reveal.
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
export type PracticeRevealed = Schemas['PracticeRevealed'];

export interface PracticeOpenRequest {
  /** The open session kept in memory, with the latest attempt known when it was opened. */
  readonly cached?: { readonly sessionId: string; readonly baselineAttemptId: string | null };
}

function failed<T>(kind: QuestionFailureKind): StudyActionResult<T> {
  return { ok: false, kind, message: QUESTION_FAILURE_MESSAGES[kind] };
}

export function practiceOpenPath(questionId: string): string {
  return `/api/questions/${encodeURIComponent(questionId)}/practice-open`;
}

export function practiceRevealPath(questionId: string): string {
  return `/api/questions/${encodeURIComponent(questionId)}/practice-reveal`;
}

/** One POST to this app's route handler, with the panel's failure mapping. */
async function post<T>(
  workspaceId: string,
  path: string,
  init: { readonly headers?: Record<string, string>; readonly body?: string },
  fetchImpl: typeof fetch,
): Promise<StudyActionResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
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
  return { ok: true, data: body as T };
}

function owned<T>(
  workspaceId: string,
  result: StudyActionResult<T>,
  owner: (data: T) => string | undefined,
): StudyActionResult<T> {
  if (!result.ok) return result;
  return owner(result.data)?.toLowerCase() === workspaceId.toLowerCase()
    ? result
    : failed('notFound');
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
  const result = await post<PracticeOpened>(
    workspaceId,
    practiceOpenPath(questionId),
    {
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(
        request.cached
          ? {
              cached_session_id: request.cached.sessionId,
              baseline_attempt_id: request.cached.baselineAttemptId,
            }
          : {},
      ),
    },
    fetchImpl,
  );
  return owned(workspaceId, result, (data) => (data.session ?? data.result)?.workspace_id);
}

/** `해설 보기`: the latest submission. The server retires this user's open sessions of the question. */
export async function revealQuestionPractice(
  workspaceId: string,
  questionId: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<StudyActionResult<PracticeRevealed>> {
  if (!isWorkspaceId(workspaceId) || !isWorkspaceId(questionId)) return failed('notFound');
  const result = await post<PracticeRevealed>(
    workspaceId,
    practiceRevealPath(questionId),
    {},
    fetchImpl,
  );
  return owned(workspaceId, result, (data) => data.result.workspace_id);
}
