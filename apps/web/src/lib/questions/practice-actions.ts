'use server';

// QOV-01 / QPLAY-01 study actions (BFF, implementation-plan §7): the browser never calls FastAPI
// directly. Inputs are untrusted: ids must be UUIDs, flags booleans. FastAPI remains the authority
// (membership, archived = read-only, own study state only, no answers before submission).
import type { Schemas } from '@quiz/api-client';
import { revalidatePath } from 'next/cache';
import { isWorkspaceId } from '@/lib/workspaces/validation';
import { overviewPath } from './overview-data';
import { findPlaced, type PlacedQuestion } from './overview-placement';
import { QUESTION_FAILURE_MESSAGES, type QuestionFailureKind } from './problems';
import { callQuestionApi, type ApiOutcome } from './server';

export type PracticeSession = Schemas['PracticeSession'];
export type MyState = Schemas['MyState'];

export type StudyActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly kind: QuestionFailureKind; readonly message: string };

export interface MyStatePatch {
  readonly is_favorite?: boolean;
  readonly needs_retry?: boolean;
}

const KEY = /^[A-Za-z0-9-]{8,128}$/;

function failed<T>(kind: QuestionFailureKind): StudyActionResult<T> {
  return { ok: false, kind, message: QUESTION_FAILURE_MESSAGES[kind] };
}

function fromOutcome<T>(outcome: ApiOutcome<T>): StudyActionResult<T> {
  return outcome.ok ? outcome : failed(outcome.failure.kind);
}

/** The heatmap of this workspace shows the new study state on its next render. */
function refresh(workspaceId: string): void {
  revalidatePath(overviewPath(workspaceId));
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
  if (outcome.ok) {
    if (outcome.data.workspace_id !== workspaceId) return failed('notFound');
    refresh(workspaceId);
  }
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
  if (outcome.ok) refresh(workspaceId);
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
