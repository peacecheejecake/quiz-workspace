'use server';

// Question server actions (the home's 문제 등록 / 문제 편집 / 삭제, QOV-01-AC12 and
// QPLAY-01-AC07/AC08; the 문제 생성 dialog's list; UX7-BANK retired the QBANK-01 page that used
// them first; UX7-BANK-2 brought back its detail reads, 보관 and the draft/archived list). Inputs are untrusted: ids are checked to be UUIDs and form values are
// re-read and re-validated here before FastAPI (the authority on authorization, revision
// consistency and content rules) is called with the session's Bearer token.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import { loginRedirectPath } from '@/lib/auth/routes';
import { isWorkspaceId } from '@/lib/workspaces/validation';
import { statusQuery, parseBankFilters, type BankFilters } from './filters';
import {
  createBody,
  fieldErrorsFromIssues,
  parseFormValues,
  parseSourceSnapshot,
  updateBody,
  validateQuestionForm,
  type FieldErrors,
  type PublicationStatus,
  type Question,
  type QuestionDetail,
  type QuestionFormValues,
} from './form';
import type { DuplicateScan, MergeGroup, MergeResult } from './duplicates';
import { QUESTION_FAILURE_MESSAGES, type QuestionFailureKind } from './problems';
import {
  callQuestionApi,
  loadChapterContext,
  questionsReturnPath,
  type ApiOutcome,
  type ChapterOption,
  type DocumentOption,
} from './server';

export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly kind: QuestionFailureKind;
      readonly message: string;
      readonly fieldErrors?: FieldErrors;
    };

export interface QuestionPage {
  readonly items: readonly Question[];
  readonly nextCursor: string | null;
}

export type QuestionRevision = Question['revision'];

const PAGE_SIZE = 50;
const isId = isWorkspaceId; // every id in this API is a UUID

function failed<T>(kind: QuestionFailureKind, fieldErrors?: FieldErrors): ActionResult<T> {
  return {
    ok: false,
    kind,
    message: QUESTION_FAILURE_MESSAGES[kind],
    ...(fieldErrors ? { fieldErrors } : {}),
  };
}

function fromOutcome<T>(outcome: ApiOutcome<T>, values?: QuestionFormValues): ActionResult<T> {
  if (outcome.ok) return outcome;
  const { kind, issues } = outcome.failure;
  if (kind === 'invalid' && values) {
    return failed(kind, fieldErrorsFromIssues(issues ?? [], values));
  }
  return failed(kind);
}

function refresh(workspaceId: string): void {
  // The home's overview (heatmap) lists the questions.
  revalidatePath(`/workspaces/${workspaceId}`, 'layout');
}

function validKey(key: unknown): string | undefined {
  return typeof key === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(key) ? key : undefined;
}

/** One page of the question list under `filters`, after `cursor`. */
export async function listQuestionsAction(
  workspaceId: string,
  filters: BankFilters,
  cursor: string | null,
): Promise<ActionResult<QuestionPage>> {
  if (!isWorkspaceId(workspaceId)) return failed('notFound');
  const f = parseBankFilters({
    q: typeof filters?.q === 'string' ? filters.q : undefined,
    type: typeof filters?.type === 'string' ? filters.type : undefined,
    chapter: typeof filters?.chapter === 'string' ? filters.chapter : undefined,
    status: typeof filters?.status === 'string' ? filters.status : undefined,
  });
  const outcome = await callQuestionApi(questionsReturnPath(workspaceId), (api) =>
    api.GET('/api/v1/workspaces/{workspace_id}/questions', {
      params: {
        path: { workspace_id: workspaceId },
        query: {
          publication_status: statusQuery(f.status),
          limit: PAGE_SIZE,
          ...(f.q ? { q: f.q } : {}),
          ...(f.type ? { question_type: f.type } : {}),
          ...(f.chapter ? { chapter_id: f.chapter } : {}),
          ...(typeof cursor === 'string' && cursor ? { cursor: cursor.slice(0, 500) } : {}),
        },
      },
    }),
  );
  if (!outcome.ok) return fromOutcome(outcome);
  return { ok: true, data: { items: outcome.data.items, nextCursor: outcome.data.next_cursor } };
}

/** Detail of one question: active revision, sources and the revision list (newest first). */
export async function getQuestionAction(
  workspaceId: string,
  questionId: string,
): Promise<ActionResult<QuestionDetail>> {
  if (!isWorkspaceId(workspaceId) || !isId(questionId)) return failed('notFound');
  return fromOutcome(
    await callQuestionApi(questionsReturnPath(workspaceId), (api) =>
      api.GET('/api/v1/questions/{question_id}', {
        params: { path: { question_id: questionId } },
      }),
    ),
  );
}

/** One immutable past revision (history view). */
export async function getQuestionRevisionAction(
  workspaceId: string,
  questionId: string,
  revisionId: string,
): Promise<ActionResult<QuestionRevision>> {
  if (!isWorkspaceId(workspaceId) || !isId(questionId) || !isId(revisionId)) {
    return failed('notFound');
  }
  return fromOutcome(
    await callQuestionApi(questionsReturnPath(workspaceId), (api) =>
      api.GET('/api/v1/questions/{question_id}/revisions/{revision_id}', {
        params: { path: { question_id: questionId, revision_id: revisionId } },
      }),
    ),
  );
}

/**
 * Registers a CONFIRMED question. `idempotencyKey` is minted by the editor per creation attempt
 * and reused for retries of the same content, so a double submit or a retry after a lost
 * response creates one question.
 */
export async function createQuestionAction(
  workspaceId: string,
  rawValues: unknown,
  idempotencyKey: unknown,
): Promise<ActionResult<Question>> {
  if (!isWorkspaceId(workspaceId)) return failed('notFound');
  const values = parseFormValues(rawValues);
  if (!values) return failed('invalid', {});
  const errors = validateQuestionForm(values);
  if (Object.keys(errors).length > 0) return failed('invalid', errors);
  const key = validKey(idempotencyKey);
  const outcome = await callQuestionApi(questionsReturnPath(workspaceId), (api) =>
    api.POST('/api/v1/workspaces/{workspace_id}/questions', {
      params: {
        path: { workspace_id: workspaceId },
        ...(key ? { header: { 'Idempotency-Key': key } } : {}),
      },
      body: createBody(values),
    }),
  );
  if (outcome.ok) refresh(workspaceId);
  return fromOutcome(outcome, values);
}

/** Edits a question on top of `baseRevisionId`; a stale base is refused (409 stale-revision). */
export async function updateQuestionAction(
  workspaceId: string,
  questionId: string,
  baseRevisionId: string,
  rawValues: unknown,
  rawBaseSources: unknown,
): Promise<ActionResult<Question>> {
  if (!isWorkspaceId(workspaceId) || !isId(questionId) || !isId(baseRevisionId)) {
    return failed('notFound');
  }
  const values = parseFormValues(rawValues);
  if (!values) return failed('invalid', {});
  const errors = validateQuestionForm(values);
  if (Object.keys(errors).length > 0) return failed('invalid', errors);
  // The sources the edit started from: unchanged sources are not sent (provenance is kept).
  const baseSources = parseSourceSnapshot(rawBaseSources);
  const outcome = await callQuestionApi(questionsReturnPath(workspaceId), (api) =>
    api.PATCH('/api/v1/questions/{question_id}', {
      params: { path: { question_id: questionId } },
      body: updateBody(values, baseRevisionId, baseSources),
    }),
  );
  if (outcome.ok) refresh(workspaceId);
  return fromOutcome(outcome, values);
}

/** Soft delete: history stays, the question leaves the overview. */
export async function deleteQuestionAction(
  workspaceId: string,
  questionId: string,
): Promise<ActionResult<null>> {
  if (!isWorkspaceId(workspaceId) || !isId(questionId)) return failed('notFound');
  const outcome = await callQuestionApi<unknown>(questionsReturnPath(workspaceId), (api) =>
    api.DELETE('/api/v1/questions/{question_id}', {
      params: { path: { question_id: questionId } },
    }),
  );
  if (!outcome.ok) {
    if (outcome.failure.kind === 'notFound') refresh(workspaceId);
    return fromOutcome(outcome);
  }
  refresh(workspaceId);
  return { ok: true, data: null };
}

export interface QuestionEditorContext {
  readonly chapters: readonly ChapterOption[];
  readonly documents: readonly DocumentOption[];
}

/**
 * The editor's chapter picker and source documents (ready books and their outlines), read when the
 * home opens the editor so the home render itself never pays for the outlines. Failures degrade
 * to empty lists.
 */
export async function questionEditorContextAction(
  workspaceId: string,
): Promise<QuestionEditorContext> {
  if (!isWorkspaceId(workspaceId)) return { chapters: [], documents: [] };
  let api;
  try {
    api = await createServerApiClient();
  } catch (error) {
    if (!(error instanceof NotAuthenticatedError)) return { chapters: [], documents: [] };
    api = null;
  }
  // redirect() throws, so it stays outside the try block.
  if (!api) redirect(loginRedirectPath(questionsReturnPath(workspaceId)));
  return loadChapterContext(api, workspaceId);
}

const STATUSES = new Set<PublicationStatus>(['DRAFT', 'CONFIRMED', 'ARCHIVED']);

/**
 * Publication status transition (UX7-BANK-2, as the retired QBANK-01 offered it): archive a
 * confirmed question (the practice panel's 보관), restore an archived one or confirm a draft (the
 * 보관·초안 문제 dialog). FastAPI checks the role, the archived workspace, the allowed transition and
 * the base revision.
 */
export async function setQuestionStatusAction(
  workspaceId: string,
  questionId: string,
  baseRevisionId: string,
  status: PublicationStatus,
): Promise<ActionResult<Question>> {
  if (!isWorkspaceId(workspaceId) || !isId(questionId) || !isId(baseRevisionId)) {
    return failed('notFound');
  }
  if (!STATUSES.has(status)) return failed('invalid');
  const outcome = await callQuestionApi(questionsReturnPath(workspaceId), (api) =>
    api.PATCH('/api/v1/questions/{question_id}', {
      params: { path: { question_id: questionId } },
      body: { base_revision_id: baseRevisionId, publication_status: status },
    }),
  );
  if (outcome.ok || outcome.failure.kind === 'notFound') refresh(workspaceId);
  return fromOutcome(outcome);
}

/** The 보관·초안 문제 dialog's filter: both (default), drafts only or archived only. */
export type InactiveFilter = 'INACTIVE' | 'DRAFT' | 'ARCHIVED';

const INACTIVE_QUERY: Readonly<Record<InactiveFilter, PublicationStatus[]>> = {
  INACTIVE: ['DRAFT', 'ARCHIVED'],
  DRAFT: ['DRAFT'],
  ARCHIVED: ['ARCHIVED'],
};

/** One page (bank order, 50) of the workspace's draft and/or archived questions, after `cursor`. */
export async function listInactiveQuestionsAction(
  workspaceId: string,
  filter: InactiveFilter,
  cursor: string | null,
): Promise<ActionResult<QuestionPage>> {
  if (!isWorkspaceId(workspaceId)) return failed('notFound');
  const statuses = Object.hasOwn(INACTIVE_QUERY, filter)
    ? INACTIVE_QUERY[filter]
    : INACTIVE_QUERY.INACTIVE;
  const outcome = await callQuestionApi(questionsReturnPath(workspaceId), (api) =>
    api.GET('/api/v1/workspaces/{workspace_id}/questions', {
      params: {
        path: { workspace_id: workspaceId },
        query: {
          publication_status: statuses,
          limit: PAGE_SIZE,
          ...(typeof cursor === 'string' && cursor ? { cursor: cursor.slice(0, 500) } : {}),
        },
      },
    }),
  );
  if (!outcome.ok) return fromOutcome(outcome);
  return { ok: true, data: { items: outcome.data.items, nextCursor: outcome.data.next_cursor } };
}

// --- 중복 문제 정리 (UX7-DEDUP, QOV-01-AC16) ----------------------------------------------------

const MAX_MERGE_GROUPS = 100;
const MAX_MERGE_DUPLICATES = 50;

/** The workspace's groups of identical confirmed questions (editors; no answers). */
export async function scanDuplicatesAction(
  workspaceId: string,
): Promise<ActionResult<DuplicateScan>> {
  if (!isWorkspaceId(workspaceId)) return failed('notFound');
  const outcome = await callQuestionApi(questionsReturnPath(workspaceId), (api) =>
    api.GET('/api/v1/workspaces/{workspace_id}/question-duplicates', {
      params: { path: { workspace_id: workspaceId } },
    }),
  );
  return fromOutcome(outcome);
}

/** Keeps one question per group and archives the others, merging their history (re-checked). */
export async function mergeDuplicatesAction(
  workspaceId: string,
  groups: readonly MergeGroup[],
): Promise<ActionResult<MergeResult>> {
  if (!isWorkspaceId(workspaceId)) return failed('notFound');
  const valid =
    Array.isArray(groups) &&
    groups.length >= 1 &&
    groups.length <= MAX_MERGE_GROUPS &&
    groups.every(
      (g) =>
        isId(g?.keep_question_id) &&
        Array.isArray(g.duplicate_question_ids) &&
        g.duplicate_question_ids.length >= 1 &&
        g.duplicate_question_ids.length <= MAX_MERGE_DUPLICATES &&
        g.duplicate_question_ids.every((id: unknown) => isId(id)),
    );
  if (!valid) return failed('invalid');
  const body = {
    groups: groups.map((g) => ({
      keep_question_id: g.keep_question_id,
      duplicate_question_ids: [...g.duplicate_question_ids],
    })),
  };
  const outcome = await callQuestionApi(questionsReturnPath(workspaceId), (api) =>
    api.POST('/api/v1/workspaces/{workspace_id}/question-duplicates/merge', {
      params: { path: { workspace_id: workspaceId } },
      body,
    }),
  );
  if (outcome.ok) refresh(workspaceId);
  return fromOutcome(outcome);
}
