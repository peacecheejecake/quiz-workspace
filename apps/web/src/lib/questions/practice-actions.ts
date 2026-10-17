'use server';

// QOV-01 / QPLAY-01 study actions (BFF, implementation-plan §7): the browser never calls FastAPI
// directly. Inputs are untrusted: ids must be UUIDs, flags booleans. FastAPI remains the authority
// (membership, archived = read-only, own study state only, no answers before submission).
// No action revalidates the overview: a server-action refresh racing the panel's
// `history.pushState` (open/previous/next/close) could restore an older `?question=`. The screen
// shows the new study state optimistically and refreshes once the panel is closed.
import type { Schemas } from '@quiz/api-client';
import { isWorkspaceId } from '@/lib/workspaces/validation';
import { overviewPath } from './overview-data';
import { findPlaced, type PlacedQuestion } from './overview-placement';
import { QUESTION_FAILURE_MESSAGES, type QuestionFailureKind } from './problems';
import { callQuestionApi, type ApiOutcome } from './server';

export type PracticeSession = Schemas['PracticeSession'];
export type MyState = Schemas['MyState'];
export type SubmitResult = Schemas['SubmitResult'];
export type SelfGradeResult = Schemas['SelfGradeResult'];

/** An answer as the panel sends it; validated here before it reaches FastAPI. */
export type PracticeSubmission =
  { readonly selected_option_ids: readonly string[] } | { readonly answer_text: string };

export type StudyActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly kind: QuestionFailureKind; readonly message: string };

export interface MyStatePatch {
  readonly is_favorite?: boolean;
  readonly needs_retry?: boolean;
}

const KEY = /^[A-Za-z0-9-]{8,128}$/;
// Mirrors the API's SubmitBody limits.
const MAX_SELECTED = 50;
const MAX_OPTION_ID = 200;
const MAX_ANSWER_TEXT = 20_000;

function failed<T>(kind: QuestionFailureKind): StudyActionResult<T> {
  return { ok: false, kind, message: QUESTION_FAILURE_MESSAGES[kind] };
}

function fromOutcome<T>(outcome: ApiOutcome<T>): StudyActionResult<T> {
  return outcome.ok ? outcome : failed(outcome.failure.kind);
}

/**
 * Opens a practice session on `questionId`: the server records the caller's view (the dot turns
 * `viewed`) and returns the question without answers. `idempotencyKey` is minted once per panel
 * opening, so a repeated request (double render, retry) opens one session.
 */
export async function openPracticeSessionAction(
  workspaceId: string,
  questionId: string,
  idempotencyKey: string,
): Promise<StudyActionResult<PracticeSession>> {
  if (!isWorkspaceId(workspaceId) || !isWorkspaceId(questionId)) return failed('notFound');
  const key =
    typeof idempotencyKey === 'string' && KEY.test(idempotencyKey) ? idempotencyKey : null;
  const outcome = await callQuestionApi(overviewPath(workspaceId), (api) =>
    api.POST('/api/v1/questions/{question_id}/practice-sessions', {
      params: {
        path: { question_id: questionId },
        ...(key ? { header: { 'Idempotency-Key': key } } : {}),
      },
      body: {},
    }),
  );
  if (outcome.ok && outcome.data.workspace_id !== workspaceId) return failed('notFound');
  return fromOutcome(outcome);
}

function submissionBody(
  answer: PracticeSubmission,
): { selected_option_ids: string[] } | { answer_text: string } | null {
  if (typeof answer !== 'object' || answer === null) return null;
  if ('selected_option_ids' in answer) {
    const ids: unknown = answer.selected_option_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_SELECTED) return null;
    const valid = ids.every(
      (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_OPTION_ID,
    );
    return valid ? { selected_option_ids: [...(ids as string[])] } : null;
  }
  if ('answer_text' in answer) {
    const text: unknown = answer.answer_text;
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_ANSWER_TEXT) {
      return null;
    }
    return { answer_text: text };
  }
  return null;
}

/**
 * Submits the answer of an open practice session. The server grades it on the session's pinned
 * revision by stable option ids and only now reveals the answers / explanation.
 */
export async function submitPracticeAction(
  workspaceId: string,
  sessionId: string,
  answer: PracticeSubmission,
): Promise<StudyActionResult<SubmitResult>> {
  if (!isWorkspaceId(workspaceId) || !isWorkspaceId(sessionId)) return failed('notFound');
  const body = submissionBody(answer);
  if (!body) return failed('invalid');
  const outcome = await callQuestionApi(overviewPath(workspaceId), (api) =>
    api.POST('/api/v1/practice-sessions/{session_id}/submit', {
      params: { path: { session_id: sessionId } },
      body,
    }),
  );
  if (outcome.ok && outcome.data.practice_session_id !== sessionId) return failed('notFound');
  return fromOutcome(outcome);
}

/** The user's own grade of a pending submission (essay, short answer without accepted answers). */
export async function selfGradePracticeAction(
  workspaceId: string,
  sessionId: string,
  result: 'correct' | 'incorrect',
): Promise<StudyActionResult<SelfGradeResult>> {
  if (!isWorkspaceId(workspaceId) || !isWorkspaceId(sessionId)) return failed('notFound');
  if (result !== 'correct' && result !== 'incorrect') return failed('invalid');
  const outcome = await callQuestionApi(overviewPath(workspaceId), (api) =>
    api.POST('/api/v1/practice-sessions/{session_id}/self-grade', {
      params: { path: { session_id: sessionId } },
      body: { result },
    }),
  );
  if (outcome.ok && outcome.data.practice_session_id !== sessionId) return failed('notFound');
  return fromOutcome(outcome);
}

/** Sets the caller's favorite / retry flags (`PATCH /questions/{id}/my-state`). */
export async function setMyStateAction(
  workspaceId: string,
  questionId: string,
  patch: MyStatePatch,
): Promise<StudyActionResult<MyState>> {
  if (!isWorkspaceId(workspaceId) || !isWorkspaceId(questionId)) return failed('notFound');
  const body: { is_favorite?: boolean; needs_retry?: boolean } = {};
  if (typeof patch?.is_favorite === 'boolean') body.is_favorite = patch.is_favorite;
  if (typeof patch?.needs_retry === 'boolean') body.needs_retry = patch.needs_retry;
  if (Object.keys(body).length === 0) return failed('invalid');
  const outcome = await callQuestionApi(overviewPath(workspaceId), (api) =>
    api.PATCH('/api/v1/questions/{question_id}/my-state', {
      params: { path: { question_id: questionId } },
      body,
    }),
  );
  return fromOutcome(outcome);
}

/**
 * The open question of a deep link (`?question=`) that the filtered heatmap does not show,
 * placed as in the unfiltered heatmap; null when it is not a CONFIRMED question of the
 * workspace. Read-only: never records a view.
 */
export async function lookupOverviewQuestionAction(
  workspaceId: string,
  questionId: string,
): Promise<StudyActionResult<PlacedQuestion | null>> {
  if (!isWorkspaceId(workspaceId) || !isWorkspaceId(questionId)) return failed('notFound');
  const outcome = await callQuestionApi(overviewPath(workspaceId), (api) =>
    api.GET('/api/v1/workspaces/{workspace_id}/questions/overview', {
      params: { path: { workspace_id: workspaceId } },
    }),
  );
  if (!outcome.ok) return failed(outcome.failure.kind);
  return { ok: true, data: findPlaced(outcome.data, questionId.toLowerCase()) };
}
