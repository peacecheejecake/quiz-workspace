'use server';

// QBANK-01 server actions. Inputs are untrusted: ids are checked to be UUIDs and form values are
// re-read and re-validated here before FastAPI (the authority on authorization, revision
// consistency and content rules) is called with the session's Bearer token.
import { revalidatePath } from 'next/cache';
import { isWorkspaceId } from '@/lib/workspaces/validation';
import { statusQuery, parseBankFilters, type BankFilters } from './filters';
import {
  createBody,
  fieldErrorsFromIssues,
  parseFormValues,
  updateBody,
  validateQuestionForm,
  type FieldErrors,
  type PublicationStatus,
  type Question,
  type QuestionDetail,
  type QuestionFormValues,
} from './form';
import { QUESTION_FAILURE_MESSAGES, type QuestionFailureKind } from './problems';
import { bankPath, callQuestionApi, type ApiOutcome } from './server';

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
  // The bank and the overview (heatmap) both list questions.
  revalidatePath(`/workspaces/${workspaceId}/questions`, 'layout');
}

function validKey(key: unknown): string | undefined {
  return typeof key === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(key) ? key : undefined;
}

/** One page of the bank under `filters`, after `cursor` ("더 보기"). */
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
  const outcome = await callQuestionApi(bankPath(workspaceId), (api) =>
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
    await callQuestionApi(bankPath(workspaceId), (api) =>
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
    await callQuestionApi(bankPath(workspaceId), (api) =>
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
  const outcome = await callQuestionApi(bankPath(workspaceId), (api) =>
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
): Promise<ActionResult<Question>> {
  if (!isWorkspaceId(workspaceId) || !isId(questionId) || !isId(baseRevisionId)) {
    return failed('notFound');
  }
  const values = parseFormValues(rawValues);
  if (!values) return failed('invalid', {});
  const errors = validateQuestionForm(values);
  if (Object.keys(errors).length > 0) return failed('invalid', errors);
  const outcome = await callQuestionApi(bankPath(workspaceId), (api) =>
    api.PATCH('/api/v1/questions/{question_id}', {
      params: { path: { question_id: questionId } },
      body: updateBody(values, baseRevisionId),
    }),
  );
  if (outcome.ok) refresh(workspaceId);
  return fromOutcome(outcome, values);
}

const STATUSES = new Set<PublicationStatus>(['DRAFT', 'CONFIRMED', 'ARCHIVED']);

/** Publication status transition (confirm a draft, archive, restore an archived question). */
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
  const outcome = await callQuestionApi(bankPath(workspaceId), (api) =>
    api.PATCH('/api/v1/questions/{question_id}', {
      params: { path: { question_id: questionId } },
      body: { base_revision_id: baseRevisionId, publication_status: status },
    }),
  );
  if (outcome.ok) refresh(workspaceId);
  return fromOutcome(outcome);
}

/** Soft delete: history stays, the question leaves the bank and the overview. */
export async function deleteQuestionAction(
  workspaceId: string,
  questionId: string,
): Promise<ActionResult<null>> {
  if (!isWorkspaceId(workspaceId) || !isId(questionId)) return failed('notFound');
  const outcome = await callQuestionApi<unknown>(bankPath(workspaceId), (api) =>
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
