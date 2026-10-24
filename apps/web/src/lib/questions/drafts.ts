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
export type ImportRegistration = Schemas['ImportRegistration'];
export type BookChapterOption = Schemas['BookChapterOption'];
export type ChapterMatch = NonNullable<ImportDraft['chapter_match']>;

/** The book chapter an import draft is registered under (CHAPTER-MAP) and why. */
export interface DraftChapterInfo {
  readonly chapter: Schemas['DraftChapterRef'] | null;
  /** `auto`: the server's suggestion; `manual`: chosen in review. */
  readonly choice: ImportDraft['chapter_choice'];
  readonly match: ChapterMatch | null;
  /** The question PDF chapter the suggestion was made from. */
  readonly sourceTitle: string | null;
}
export type DraftUpdateBody = Schemas['QuestionDraftUpdate'];
export type ReviewedDraftRef = Schemas['ReviewedDraft'];
export type ReviewStatus = ImportDraft['review_status'];
export type DraftOrigin = ImportDraft['payload']['origin'];
export type GeneratedVariationType = NonNullable<ImportDraft['variation_type']>;

export interface DraftOption {
  readonly id: string;
  readonly text: string;
  readonly correct: boolean;
}

export interface DraftLocation {
  readonly page: number;
  readonly bbox: { x0: number; y0: number; x1: number; y1: number } | null;
}

/** One cited book passage of a generated draft (QGEN-01 evidence). */
export interface DraftEvidenceRef {
  readonly documentId: string;
  /** 1-based pages of the cited blocks (ascending, unique). */
  readonly pages: readonly number[];
  /** Verbatim excerpt the generator cited (null = none). */
  readonly quote: string | null;
}

/** What a generation draft adds to the common review model (QGEN-01). */
export interface GenerationDraftInfo {
  readonly variationType: GeneratedVariationType | null;
  readonly parentQuestionId: string | null;
  readonly sourceRevisionId: string | null;
  /** Why the generator says the answer is correct (from the passages). */
  readonly justification: string | null;
  readonly evidence: readonly DraftEvidenceRef[];
  /** Blocking validations the reviewer already confirmed (e.g. `question_type_changed`). */
  readonly acknowledgedCodes: readonly string[];
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
  /** Generation drafts only (QGEN-01); absent for PDF import drafts. */
  readonly generation?: GenerationDraftInfo;
  /** PDF import drafts only (CHAPTER-MAP). */
  readonly chapter?: DraftChapterInfo;
}

function generationInfo(draft: ImportDraft): GenerationDraftInfo {
  const p = draft.payload;
  return {
    variationType: draft.variation_type ?? p.variation_type ?? null,
    parentQuestionId: p.parent_question_id ?? null,
    sourceRevisionId: p.source_question_revision_id ?? null,
    justification: p.justification ?? null,
    evidence: p.evidence.map((e) => ({
      documentId: e.document_id,
      pages: [...new Set(e.locations.map((l) => l.page))].sort((a, b) => a - b),
      quote: e.quote ?? null,
    })),
    acknowledgedCodes: draft.acknowledged_codes ?? [],
  };
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
    ...(p.origin === 'generation'
      ? { generation: generationInfo(draft) }
      : {
          chapter: {
            chapter: draft.chapter ?? null,
            choice: draft.chapter_choice ?? 'auto',
            match: draft.chapter_match ?? null,
            sourceTitle: draft.source_chapter_title ?? null,
          },
        }),
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
  // Generation drafts (QGEN-01, book_core.generation validation codes).
  inverted_answer_mismatch:
    '복수 정답: 보기를 그대로 두고 정오를 뒤집어 원래 정답이 아니던 보기들이 모두 정답이 되었습니다. 편집에서 정답을 다시 지정하거나 보기를 고쳐 주세요.',
  answer_count_changed:
    '정답 수가 원본과 달라졌습니다. 편집에서 "복수 정답 허용"을 켜서 확인하거나 보기를 다시 구성해 주세요.',
  question_type_changed: '문제 유형이 원본과 달라졌습니다. 변경을 확인해야 승인할 수 있습니다.',
  polarity_unchanged: '문제의 긍정/부정 표현이 원본과 같아 보입니다. 문구를 확인해 주세요.',
  stem_unchanged: '문제 문구가 원본과 같습니다.',
  duplicate_of_source: '원본 문제와 같은 문제입니다.',
  duplicate_of_existing: '이 Workspace에 이미 같은 문제가 있습니다.',
  duplicate_candidate: '같은 생성 작업의 다른 초안과 같은 문제입니다.',
  duplicate_option_text: '같은 내용의 보기가 두 번 있습니다.',
  source_not_cited: '원본 문서의 근거를 인용하지 않았습니다.',
  citation_unknown_passage: '제공되지 않은 원문을 근거로 인용했습니다.',
  citation_not_in_passage: '인용문이 원문에 없습니다. 근거를 확인해 주세요.',
  citation_too_short: '인용문이 너무 짧아 근거로 확인할 수 없습니다.',
  evidence_not_in_passages: '근거가 원본 문제의 출처 쪽에 없습니다.',
  justification_missing: '정답 근거 설명이 없습니다.',
  invalid_option_labels: '보기 번호가 올바르지 않습니다.',
  too_many_options: '보기가 너무 많습니다.',
  option_text_empty: '내용이 비어 있는 보기가 있습니다.',
  option_text_too_long: '보기 내용이 너무 깁니다.',
  empty_stem: '문제 내용이 비어 있습니다.',
  stem_too_long: '문제 내용이 너무 깁니다.',
  text_too_long: '내용이 너무 깁니다.',
  answer_text_invalid: '허용 답안이 올바르지 않습니다.',
  draft_invalid: '초안 형식이 올바르지 않습니다.',
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

/**
 * Content edit of a generation draft. Sending `question_type` confirms a changed question type
 * (API `question_type_changed`), so it is sent only when the reviewer changed the type in the
 * editor; the explicit confirmation is `confirmTypeBody`.
 */
export function generationDraftUpdateBody(
  values: QuestionFormValues,
  draft: Pick<ReviewDraft, 'type'>,
  baseVersion: string,
): DraftUpdateBody {
  const body = draftUpdateBody(values, baseVersion);
  if (values.type !== draft.type) return body;
  const { question_type: _unchanged, ...rest } = body;
  return rest;
}

/** Confirms the generated draft's question type (clears the blocking `question_type_changed`). */
export function confirmTypeBody(draft: Pick<ReviewDraft, 'version' | 'type'>): DraftUpdateBody {
  return { base_version: draft.version, question_type: draft.type };
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

// ---------------------------------------------------------------------------------------------
// Selection (QIMPORT-01, QIMP-BULK): checking a draft is screen state only; "선택한 문제 승인 및
// 등록" hands the selection to the server, which approves and registers it (QIMP-JOB).
// ---------------------------------------------------------------------------------------------

export type RefusalReason = Schemas['ImportRefusedDraft']['reason'];

export interface RefusedDraft {
  readonly draft_id: string;
  readonly reason: RefusalReason;
}

/** Why the draft cannot be selected (null = it can): registered, or blocked by a validation. */
export function selectionBlocker(draft: ReviewDraft): string | null {
  if (draft.publishedQuestionId !== null || draft.publishable) return null;
  return approvalBlocker({ ...draft, reviewStatus: 'pending' });
}

export function isSelectable(draft: ReviewDraft): boolean {
  return draft.publishedQuestionId === null && draft.publishable;
}

/**
 * What "전체 선택" covers: selectable drafts with nothing to check — not excluded (rejected), an
 * answer present and no validation notes. A draft without an answer (short answer / essay may be
 * confirmed without one) or with a note is selected one by one, never silently in bulk.
 */
export function selectAllScope(drafts: readonly ReviewDraft[]): ReviewDraft[] {
  return drafts.filter(
    (d) =>
      isSelectable(d) && d.reviewStatus !== 'rejected' && !d.answerMissing && d.issues.length === 0,
  );
}

/** Initial selection: drafts already approved (e.g. before QIMP-BULK) but not registered. */
export function initialSelection(drafts: readonly ReviewDraft[]): Set<string> {
  return new Set(
    drafts.filter((d) => isSelectable(d) && d.reviewStatus === 'approved').map((d) => d.id),
  );
}

/** Drops ids that are gone, registered or no longer selectable (e.g. after an edit or reload). */
export function pruneSelection(
  drafts: readonly ReviewDraft[],
  selected: ReadonlySet<string>,
): Set<string> {
  return new Set(drafts.filter((d) => selected.has(d.id) && isSelectable(d)).map((d) => d.id));
}

export type SelectAllState = boolean | 'indeterminate';

/** The "전체 선택" checkbox: checked when its whole scope is selected, indeterminate if partly. */
export function selectAllState(
  drafts: readonly ReviewDraft[],
  selected: ReadonlySet<string>,
): SelectAllState {
  const scope = selectAllScope(drafts);
  const count = drafts.filter((d) => selected.has(d.id) && isSelectable(d)).length;
  if (count === 0) return false;
  return scope.length > 0 && scope.every((d) => selected.has(d.id)) ? true : 'indeterminate';
}

/** Toggling "전체 선택": on selects the whole scope (keeps other picks), off clears everything. */
export function toggleAll(
  drafts: readonly ReviewDraft[],
  selected: ReadonlySet<string>,
  on: boolean,
): Set<string> {
  if (!on) return new Set();
  return new Set([...pruneSelection(drafts, selected), ...selectAllScope(drafts).map((d) => d.id)]);
}

export function toggleOne(
  selected: ReadonlySet<string>,
  draftId: string,
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  if (on) next.add(draftId);
  else next.delete(draftId);
  return next;
}

/** The selected drafts in list order, each at the version on screen (the version approved). */
export function approvePublishSelection(
  drafts: readonly ReviewDraft[],
  selected: ReadonlySet<string>,
): ReviewedDraftRef[] {
  return drafts
    .filter((d) => selected.has(d.id) && isSelectable(d))
    .map((d) => ({ draft_id: d.id, version: d.version }));
}

const REFUSAL_LABELS: Readonly<Record<RefusalReason, string>> = {
  'stale-draft': '다른 곳에서 바뀜',
  'not-publishable': '승인 불가 항목 있음',
};

/** Inline message on a refused draft. */
export function refusalText(reason: RefusalReason): string {
  return reason === 'stale-draft'
    ? '선택한 뒤 다른 곳에서 바뀌어 등록하지 않았습니다. 바뀐 내용을 확인한 뒤 다시 등록해 주세요.'
    : '승인할 수 없는 항목이 있어 등록하지 않았습니다. 편집에서 표시된 항목을 고쳐 주세요.';
}

// ---------------------------------------------------------------------------------------------
// Chapter (CHAPTER-MAP): the suggestion from the question PDF's chapter, or the reviewer's choice
// ---------------------------------------------------------------------------------------------

/** Picker value of "챕터 없음". */
export const NO_DRAFT_CHAPTER = '__none__';

/** Why the draft has the chapter it has (null = nothing to explain). */
export function chapterHint(info: DraftChapterInfo, optionCount: number): string | null {
  const source = info.sourceTitle ? `‘${info.sourceTitle}’` : '문제의 챕터';
  if (info.choice === 'manual') {
    return info.chapter ? '직접 고른 챕터로 등록합니다.' : '챕터 없이 등록합니다(직접 선택).';
  }
  switch (info.match) {
    case 'matched':
      return `문제 PDF의 ${source}에 맞춰 자동으로 골랐습니다.`;
    case 'ambiguous':
      return `${source}와 이름이 같은 교재 챕터가 여러 개라 자동으로 고르지 않았습니다. 직접 골라 주세요.`;
    case 'no_source_chapter':
      return '문제 PDF에서 이 문제의 챕터를 찾지 못해 챕터 없이 등록됩니다.';
    case 'no_match':
      return optionCount === 0
        ? '목차가 있는 교재가 없어 챕터 없이 등록됩니다.'
        : `문제 PDF의 ${source}와 같은 교재 챕터가 없어 챕터 없이 등록됩니다.`;
    default:
      return null;
  }
}

/** PATCH body that sets the draft's chapter (null = 챕터 없음) at the version on screen. */
export function chapterBody(
  draft: Pick<ReviewDraft, 'version'>,
  chapterId: string | null,
): DraftUpdateBody {
  return { base_version: draft.version, chapter_id: chapterId };
}

// ---------------------------------------------------------------------------------------------
// Server-side registration (QIMP-JOB): the selection is submitted once and a server job approves
// and registers it; the screen only follows its progress (and reattaches after a reload).
// ---------------------------------------------------------------------------------------------

export function isRegistrationActive(registration: Pick<ImportRegistration, 'status'>): boolean {
  return registration.status === 'queued' || registration.status === 'running';
}

/** "승인·등록 중 · k개 중 n개 처리" and the bar value (0-100). */
export function registrationProgress(
  registration: Pick<ImportRegistration, 'processed' | 'total'>,
): { readonly text: string; readonly value: number } {
  const { processed, total } = registration;
  return {
    text: `승인·등록 중 · ${total}개 중 ${processed}개 처리`,
    value: total > 0 ? Math.round((processed / total) * 100) : 0,
  };
}

/** Shown under the registration progress: nothing about it needs the page. */
export const REGISTRATION_BACKGROUND_HINT =
  '이 페이지를 떠나도 선택한 문제의 승인·등록은 서버에서 계속됩니다. 다시 열면 진행 상황을 이어서 볼 수 있습니다.';

const REGISTRATION_FAILURES: Readonly<Record<string, string>> = {
  workspace_unavailable:
    'Workspace가 보관되었거나 편집 권한이 없어 나머지 초안을 등록하지 못했습니다.',
  cancelled: '등록 작업이 취소되었습니다.',
};

/** Why a registration stopped before every draft was processed. */
export function registrationFailureMessage(
  registration: Pick<ImportRegistration, 'error_code' | 'registered'>,
): string {
  const reason =
    (registration.error_code && REGISTRATION_FAILURES[registration.error_code]) ||
    '일시적인 오류로 나머지 초안을 등록하지 못했습니다.';
  const partial =
    registration.registered > 0 ? ` 지금까지 ${registration.registered}개를 등록했습니다.` : '';
  return `선택한 문제를 모두 등록하지 못했습니다.${partial} ${reason}`;
}

/** Summary of the drafts a registration refused, by their printed number. */
export function registrationRefusedMessage(refused: ImportRegistration['refused']): string {
  const list = refused
    .map((r) => `${r.question_number ?? r.position + 1}번(${REFUSAL_LABELS[r.reason]})`)
    .join(', ');
  return `${refused.length}개는 등록하지 못했습니다: ${list}. 선택은 그대로 두었으니 확인한 뒤 다시 등록해 주세요.`;
}

/** Replaces one draft (after an edit or a review change) and keeps the order. */
export function replaceDraft(drafts: readonly ReviewDraft[], next: ReviewDraft): ReviewDraft[] {
  return drafts.map((d) => (d.id === next.id ? next : d));
}

export function sortDrafts(drafts: readonly ReviewDraft[]): ReviewDraft[] {
  return [...drafts].sort((a, b) => a.position - b.position);
}
