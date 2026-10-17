// Question draft review model shared by QIMPORT-01 (PDF import drafts) and QGEN-01 (generation
// drafts, M6.3). Pure: the normalized draft the `QuestionDraftReview` component shows, the editor
// form <-> request body mapping, approval/publish selection and the Korean labels.
//
// Rules (docs/questions.md §5-6, AGENTS.md §5): a draft never becomes a question by itself. A
// human approves exactly the reviewed content (`PATCH /question-drafts/{id}` with the draft's
// `version` as `base_version`), and publishing sends each approved draft with the version that
// was approved, so content that changed after the review is refused (409 stale-draft).
// Answers come only from the source: a missing answer stays null until the reviewer enters one.
import type { Schemas } from '@quiz/api-client';
import {
  acceptedAnswerList,
  LIMITS,
  MESSAGES,
  validateQuestionForm,
  type FieldErrors,
  type QuestionFormValues,
  type QuestionType,
} from './form';

export type ImportDraft = Schemas['ImportDraft'];
export type ImportRun = Schemas['ImportRun'];
export type DraftUpdateBody = Schemas['QuestionDraftUpdate'];
export type ReviewedDraftRef = Schemas['ReviewedDraft'];
export type ReviewStatus = ImportDraft['review_status'];
export type DraftOrigin = ImportDraft['payload']['origin'];

export interface DraftOption {
  readonly id: string;
  readonly text: string;
  readonly correct: boolean;
}

export interface DraftLocation {
  readonly page: number;
  readonly bbox: { x0: number; y0: number; x1: number; y1: number } | null;
}

/** A draft as the review UI shows it, whatever produced it (PDF import or generation). */
export interface ReviewDraft {
  readonly id: string;
  /** Opaque; changes with every write. Sent as `base_version` / publish `version`. */
  readonly version: string;
  readonly origin: DraftOrigin;
  readonly position: number;
  readonly questionNumber: number | null;
  readonly type: QuestionType;
  readonly stem: string;
  readonly options: readonly DraftOption[];
  readonly isMultiAnswer: boolean;
  /** null = the source has no answer key for this question. */
  readonly correctOptionIds: readonly string[] | null;
  readonly acceptedAnswers: readonly string[] | null;
  readonly rubric: string | null;
  readonly explanation: string | null;
  readonly answerMissing: boolean;
  readonly reviewStatus: ReviewStatus;
  readonly publishedQuestionId: string | null;
  /** Can be approved as it is. */
  readonly publishable: boolean;
  /** Validation codes (`answer_missing` is shown separately as "정답 없음"). */
  readonly issues: readonly { readonly code: string; readonly severity: 'warning' | 'error' }[];
  /** Source document of the evidence (PDF import: the uploaded paper). */
  readonly sourceDocumentId: string | null;
  /** Source pages (1-based, ascending, unique). */
  readonly pages: readonly number[];
  readonly locations: readonly DraftLocation[];
}

export function reviewDraftFromImport(draft: ImportDraft): ReviewDraft {
  const p = draft.payload;
  const correct = p.correct_option_ids ?? null;
  const correctSet = new Set(correct ?? []);
  const evidence = p.evidence[0];
  const locations: DraftLocation[] = p.evidence.flatMap((e) =>
    e.locations.map((l) => ({ page: l.page, bbox: l.bbox ?? null })),
  );
  const pages = [
    ...new Set(draft.pages.length > 0 ? draft.pages : locations.map((l) => l.page)),
  ].sort((a, b) => a - b);
  return {
    id: draft.id,
    version: draft.version,
    origin: p.origin,
    position: draft.position,
    questionNumber: draft.question_number,
    type: draft.question_type,
    stem: p.stem,
    options: p.options.map((o) => ({ id: o.id, text: o.text, correct: correctSet.has(o.id) })),
    isMultiAnswer: draft.is_multi_answer,
    correctOptionIds: correct,
    acceptedAnswers: p.accepted_answers ?? null,
    rubric: draft.rubric,
    explanation: p.explanation ?? null,
    answerMissing: draft.answer_missing,
    reviewStatus: draft.review_status,
    publishedQuestionId: draft.published_question_id,
    publishable: draft.publishable,
    issues: draft.validations
      .filter((v) => v.code !== 'answer_missing')
      .map((v) => ({ code: v.code, severity: v.severity })),
    sourceDocumentId: evidence?.document_id ?? null,
    pages,
    locations,
  };
}

/** "N번" label of a draft: the number printed in the source, else its position. */
export function draftNumber(draft: Pick<ReviewDraft, 'questionNumber' | 'position'>): number {
  return draft.questionNumber ?? draft.position + 1;
}

// ---------------------------------------------------------------------------------------------
// Labels (Korean; the API's English validation messages never reach the UI)
// ---------------------------------------------------------------------------------------------

export const REVIEW_STATUS_LABELS: Readonly<Record<ReviewStatus | 'published', string>> = {
  pending: '검토 대기',
  approved: '승인됨',
  rejected: '제외됨',
  published: '등록됨',
};

export const DRAFT_ORIGIN_LABELS: Readonly<Record<DraftOrigin, string>> = {
  pdf_import: 'PDF 가져오기',
  generation: '변형 출제',
};

const ISSUE_MESSAGES: Readonly<Record<string, string>> = {
  duplicate_option_id: '보기 식별자가 중복되었습니다. 보기를 다시 저장해 주세요.',
  mcq_too_few_options: `객관식 문제에는 보기가 ${LIMITS.minConfirmedOptions}개 이상 필요합니다.`,
  mcq_text_answer: '객관식 문제에 글로 된 답안이 들어 있습니다. 정답 보기를 선택해 주세요.',
  answer_not_in_options: '정답이 보기 목록에 없습니다. 정답 보기를 다시 선택해 주세요.',
  duplicate_answer_option: '같은 정답 보기가 두 번 지정되었습니다.',
  empty_answer: '정답이 비어 있습니다. 정답을 입력해 주세요.',
  mcq_multi_inconsistent: '복수 정답 설정과 정답 개수가 맞지 않습니다.',
  options_not_allowed: '이 유형에는 보기를 둘 수 없습니다.',
  option_answer_not_allowed: '이 유형에는 정답 보기를 지정할 수 없습니다.',
  provenance_missing: '원본 PDF의 쪽 정보가 없습니다.',
};

export function issueMessage(code: string): string {
  return ISSUE_MESSAGES[code] ?? '확인이 필요한 항목이 있습니다.';
}

/** Why the approve control is unavailable (null = it can be approved). */
export function approvalBlocker(draft: ReviewDraft): string | null {
  if (draft.publishedQuestionId) return null;
  if (draft.publishable || draft.reviewStatus === 'approved') return null;
  if (draft.type === 'MCQ' && (draft.correctOptionIds ?? []).length === 0) {
    return '정답 보기를 지정해야 승인할 수 있습니다. 편집에서 정답을 선택해 주세요.';
  }
  return '내용을 확인해야 승인할 수 있습니다. 편집에서 표시된 항목을 고쳐 주세요.';
}

// ---------------------------------------------------------------------------------------------
// Editor form <-> draft
// ---------------------------------------------------------------------------------------------

/** Editor values of a draft. Option ids are kept verbatim (grading uses them). */
export function formFromDraft(draft: ReviewDraft): QuestionFormValues {
  return {
    type: draft.type,
    stem: draft.stem,
    options: draft.options.map((o) => ({ id: o.id, text: o.text, correct: o.correct })),
    multiAnswer: draft.isMultiAnswer,
    acceptedAnswers: (draft.acceptedAnswers ?? []).join('\n'),
    explanation: draft.explanation ?? '',
    rubric: draft.rubric ?? '',
    chapterId: '',
    questionNumber: draft.questionNumber == null ? '' : String(draft.questionNumber),
    sources: [],
  };
}

/**
 * Draft edits follow the question rules except that an answer may stay unknown (null): a draft
 * without an answer can be saved, it just cannot be approved until one is entered.
 */
export function validateDraftForm(values: QuestionFormValues): FieldErrors {
  const errors: Record<string, string> = {
    ...validateQuestionForm({ ...values, chapterId: '', sources: [] }),
  };
  if (errors.correct === MESSAGES.correctRequired) delete errors.correct;
  return errors;
}

function nullIfBlank(value: string): string | null {
  return value.trim() === '' ? null : value;
}

/** Full content edit of a draft on top of `baseVersion` (review status is left to the server). */
export function draftUpdateBody(values: QuestionFormValues, baseVersion: string): DraftUpdateBody {
  const isMcq = values.type === 'MCQ';
  const correct = values.options.filter((o) => o.correct).map((o) => o.id);
  const answers = acceptedAnswerList(values.acceptedAnswers);
  const number = values.questionNumber.trim();
  return {
    base_version: baseVersion,
    question_type: values.type,
    stem: values.stem,
    options: isMcq ? values.options.map((o) => ({ id: o.id, text: o.text })) : [],
    correct_option_ids: isMcq && correct.length > 0 ? correct : null,
    is_multi_answer: isMcq && values.multiAnswer,
    accepted_answers: values.type === 'SHORT_ANSWER' && answers.length > 0 ? answers : null,
    explanation: nullIfBlank(values.explanation),
    rubric: values.type === 'ESSAY' ? nullIfBlank(values.rubric) : null,
    question_number: /^\d+$/.test(number) ? Number(number) : null,
  };
}

/** Approve (`true`) or return to pending (`false`) exactly the version on screen. */
export function reviewBody(
  draft: Pick<ReviewDraft, 'version'>,
  approved: boolean,
): DraftUpdateBody {
  return { base_version: draft.version, review_status: approved ? 'approved' : 'pending' };
}

// ---------------------------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------------------------

/** Approved drafts not registered yet, each with the version that was approved. */
export function publishSelection(drafts: readonly ReviewDraft[]): ReviewedDraftRef[] {
  return drafts
    .filter((d) => d.reviewStatus === 'approved' && d.publishedQuestionId === null)
    .map((d) => ({ draft_id: d.id, version: d.version }));
}

/** Applies a publish result (`{draft_id, question_id}[]`) to the drafts on screen. */
export function applyPublished(
  drafts: readonly ReviewDraft[],
  items: readonly { readonly draft_id: string; readonly question_id: string }[],
): ReviewDraft[] {
  const published = new Map(items.map((i) => [i.draft_id, i.question_id]));
  return drafts.map((d) => {
    const questionId = published.get(d.id);
    return questionId ? { ...d, publishedQuestionId: questionId } : d;
  });
}

export function publishedMessage(count: number): string {
  return `${count}개 문제를 문제은행에 등록했습니다.`;
}

/** The API registers at most this many drafts per publish request (`MAX_PUBLISH`). */
export const PUBLISH_BATCH_SIZE = 200;

export function publishBatches(
  selection: readonly ReviewedDraftRef[],
  size = PUBLISH_BATCH_SIZE,
): ReviewedDraftRef[][] {
  const batches: ReviewedDraftRef[][] = [];
  for (let i = 0; i < selection.length; i += size) batches.push(selection.slice(i, i + size));
  return batches;
}

export interface PublishedItem {
  readonly draft_id: string;
  readonly question_id: string;
}

/**
 * Publishes `selection` in sequential batches of at most `size`. Each batch is idempotent on the
 * server, so after a failure the caller retries with what is still unpublished (the drafts that
 * `onBatch` marked as published drop out of the next selection). Resolves with every registered
 * item, or rejects with the first failure after reporting the batches that succeeded.
 */
export async function publishInBatches(
  selection: readonly ReviewedDraftRef[],
  send: (batch: readonly ReviewedDraftRef[]) => Promise<PublishedItem[]>,
  onBatch: (items: readonly PublishedItem[]) => void,
  size = PUBLISH_BATCH_SIZE,
): Promise<PublishedItem[]> {
  const all: PublishedItem[] = [];
  for (const batch of publishBatches(selection, size)) {
    const items = await send(batch);
    all.push(...items);
    onBatch(items);
  }
  return all;
}

/** Replaces one draft (after an edit or a review change) and keeps the order. */
export function replaceDraft(drafts: readonly ReviewDraft[], next: ReviewDraft): ReviewDraft[] {
  return drafts.map((d) => (d.id === next.id ? next : d));
}

export function sortDrafts(drafts: readonly ReviewDraft[]): ReviewDraft[] {
  return [...drafts].sort((a, b) => a.position - b.position);
}
