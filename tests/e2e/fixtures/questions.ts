// Question bank (QBANK-01) and question PDF import (QIMPORT-01) fixtures: public-API factories,
// the synthetic question paper, and the role/label UI contract. M4.0 keeps every assumption about
// M4.2a/M4.2b/M4.4a/M4.4b in this header; a deliberate change is a one-place edit here (and in
// tests/integration/questions/conftest.py, which mirrors the API half).
//
// Grounded in the docs: routes (docs/architecture.md §6), types MCQ/SHORT_ANSWER/ESSAY,
// publication_status DRAFT/CONFIRMED/ARCHIVED, revisions with options `{id, text}`,
// `correct_option_ids` / `accepted_answers` (null = unknown), question_sources pages, drafts with a
// book_core `QuestionDraft` payload and review_status pending/approved/rejected
// (supabase/migrations/20261017180000_question_domain.sql), authz outcomes 404 / 403
// insufficient-role / 403 workspace-archived (implementation-plan §7).
//
// NOT in the docs (M4.0 assumptions, to confirm or change in M4.2a/M4.4a):
//   A1 Question API bodies
//      POST  /workspaces/{id}/questions  QuestionInput → 201 Question (publication_status CONFIRMED)
//      GET   /workspaces/{id}/questions?q=&question_type=&chapter_id=  → 200 {items: Question[]}
//            (the bank: CONFIRMED questions only; drafts never appear)
//      GET   /questions/{id}  → 200 Question
//      PATCH /questions/{id}  {base_revision_id, ...QuestionInput} → 200 Question with a NEW
//            revision (version + 1); a stale base_revision_id → 409 (revision consistency)
//      QuestionInput = {question_type, stem, options?, correct_option_ids?, is_multi_answer?,
//                       accepted_answers?, explanation?, rubric?, chapter_id?,
//                       sources?: [{document_id, page_start, page_end}]}
//      Question = {id, workspace_id, question_type, publication_status, chapter_id, origin,
//                  revision: {id, version, stem, options, correct_option_ids, accepted_answers,
//                             is_multi_answer, explanation, rubric},
//                  sources: [{document_id, page_start, page_end}]}
//   A2 MCQ option ids are opaque strings chosen by the client (the UI generates them); the server
//      validates them (unique, non-blank) and keeps them across edits. CONFIRMED MCQ needs >= 1
//      correct option id (migration comment: "CONFIRMED MCQ needs an answer", validated by API),
//      otherwise 422.
//   A3 `chapter_id` is a document outline node id (GET /documents/{id}/outline, M3.0 assumption).
//   A4 Question PDFs reuse the document upload flow (decided, implementation-plan §7): the
//      upload-intent body carries `document_type: "question_paper"` (documents.type; such documents are
//      excluded from book search by default), then
//      POST /workspaces/{id}/question-imports {document_id} (+ optional `Idempotency-Key`
//           header: same key → same run) → 202 ImportRun
//      GET  /workspaces/{id}/question-imports → 200 {items: ImportRun[]}  (newest first; the
//           runs table has a (workspace_id, created_at desc) index for this listing)
//      GET  /question-imports/{id}            → 200 ImportRun
//      GET  /question-imports/{id}/drafts     → 200 {items: Draft[]} ordered by position
//      POST /question-imports/{id}/publish {drafts: [{draft_id, version}]}
//           → 200 {items: [{draft_id, question_id}]} (changed by the M4.4a review fix: was
//           {draft_ids}, which approved + published in one step). Registers exactly those
//           drafts, which must already be APPROVED (PATCH below) at the `version` the client
//           reviewed: a changed draft → 409 stale-draft, a pending/rejected one → 409
//           draft-not-approved, nothing registered. Idempotent per draft (unique
//           published_question_id; an already published draft replays whatever version is sent).
//           An MCQ draft without an answer cannot be approved (422) until an answer is entered.
//      POST /question-imports/{id}/retry      → 202 ImportRun (same run, new job_id) after the
//           run failed; the retried job must not duplicate drafts persisted by the failed attempt
//      ImportRun = {id, status, job_id, source_document_id}; the job is polled at GET /jobs/{id}.
//      Draft = {id, position, question_type, review_status, published_question_id, validations,
//               payload: QuestionDraft (book_core schema_version 1)}
//      M4.4a confirmed the above and added (contracts/openapi.json is the reference):
//      ImportRun += {source_document_revision_id, document_title, error_code, draft_count,
//                    published_count, created_at, updated_at, finished_at}
//      Draft += {import_id, question_number, is_multi_answer, rubric, answer_missing, pages,
//                publishable, publish_errors: [{field, message}], version, ...timestamps}
//            `rubric` = an essay's model answer / grading criteria (a model answer printed in the
//            paper lands there, never in accepted_answers); answer_missing counts it.
//      PATCH /question-drafts/{id} {base_version: Draft.version, question_type?, stem?, options?,
//            correct_option_ids?, is_multi_answer?, accepted_answers?, explanation?, rubric?,
//            question_number?, review_status?: pending|approved|rejected} → 200 Draft; a stale
//            base_version → 409 stale-draft; a published draft → 409 draft-published; approving
//            a draft that is not publishable → 422 (validations are recomputed after an edit);
//            any change without `approved` returns an approved draft to pending; rejecting or
//            reopening never depends on the content rules.
//      Errors: start from a non-ready paper → 409 document-not-ready; a book or unknown document
//      → 422; retry of a run that is not failed/cancelled → 409 import-not-retryable.
//   A5 QIMPORT-01-AC01 says "a PDF with 5 questions → 5 drafts"; the only synthetic question
//      paper (tests/fixtures/pdfs/questions-ko.pdf, M1.1) has 8, so the tests expect one draft per
//      truth question (8). Its key covers 1, 2, 4, 5, 8: questions 3 (MCQ), 6 (short), 7 (essay)
//      have no answer.
//   A6 "Heatmap marker +N" (QIMPORT-01-AC03) is asserted as +N CONFIRMED questions in the bank
//      (questions.md §3.1: one marker = one CONFIRMED question); the heatmap UI/overview API is
//      QOV-01 (M5).
//   A7 Fault injection (decided, implementation-plan §7): fake adapters active only with
//      APP_ENV=test fail deterministically on an `E2E-FAIL-…` marker. IMPORT_FAILURE_MARKER in the
//      uploaded file name (a copy of questions-ko.pdf, same bytes) makes the fake extractor fail
//      the run's FIRST job after persisting a strict, non-empty subset of the drafts (the first
//      half in position order: 4 of 8), so they stay listed by GET /question-imports/{id}/drafts
//      and shown on the import screen; the retried job succeeds and must reconcile with them.
//
// M5.0 assumptions about M5.1/M5.2/M5.4/M5.5 (QOV-01 heatmap, QPLAY-01 practice panel; mirrored
// in tests/integration/questions/test_{overview,practice}_api_contract.py):
//   A8 Overview API (architecture §6, questions.md §2/§3/§7)
//      GET /workspaces/{id}/questions/overview → 200 Overview
//      Overview = {counts: {total, unseen, viewed, incorrect, correct, retry, favorite},
//                  chapters: [{id: string|null, number: number|null, title}],
//                  items: OverviewItem[]}
//      OverviewItem = {question_id, chapter_id, question_number, question_type, status,
//                      is_favorite, needs_retry, last_graded_result, is_pending_grading, preview}
//      for the CALLER's study state; CONFIRMED, non-deleted questions only (drafts never), in
//      chapter sort order then question order. Status counts are mutually exclusive (retry wins),
//      `favorite` overlaps them. No answer/explanation fields (ANSWER_KEYS); reading the overview
//      never records a view.
//   A9 A1's QuestionInput gains an optional `question_number` (positive int; the
//      questions.question_number column). Heatmap dots are labelled with it via M5.3's
//      questionDotLabel (`3장 12번 문제, 객관식, …`); a question without a chapter sits in one
//      "챕터 없음" group (`챕터 없음 12번 문제, …`). The M5.0 specs always pass a number.
//   A10 Practice API (architecture §6, questions.md §4)
//      POST /questions/{id}/practice-sessions {} → 201 PracticeSession
//           {id, question_id, question_revision_id, question_type, stem, is_multi_answer,
//            options: [{id, text}] in DISPLAYED order, state: "open"}
//           never carries ANSWER_KEYS; records the caller's view (first/last_viewed_at). MCQ
//           options are shuffled per session (random, so 100 sessions of a 4-option MCQ show more
//           than one order) and the displayed order is stored (displayed_option_ids).
//      POST /practice-sessions/{id}/submit {selected_option_ids} (MCQ) | {answer_text} → 200
//           SubmitResult {attempt_id, result: correct|incorrect|pending, correct_option_ids,
//           accepted_answers, explanation, rubric}: answers are revealed only here. A second
//           submit on the same session → 409; an unknown option id, or two ids on a single-answer
//           MCQ → 422. MCQ grading = set equality of option ids (order-free).
//      POST /practice-sessions/{id}/self-grade {result: "correct"|"incorrect"} → 200
//           {attempt_id, result, grades_attempt_id} for a pending submission only (else 409);
//           appends a new attempt, the pending one never changes (M4.1 schema).
//      PATCH /questions/{id}/my-state {is_favorite?, needs_retry?} → 200 MyState
//           {question_id, status, is_favorite, needs_retry, last_graded_result}
//      GET /questions/{id}/attempts → 200 {items: Attempt[]}, the caller's own, newest first;
//           Attempt = {id, question_revision_id, practice_session_id, displayed_option_ids,
//                      submitted_answer, result, grading_method, grades_attempt_id,
//                      submitted_at, graded_at}; submitted_answer is the submit body
//           ({selected_option_ids} | {answer_text}); a self-grade row copies the pending one's.
//      A session is graded against the revision it was opened on, even after an edit. Another
//      user's session → 404 (same body as an unknown id). Viewers may practise (own state only).
//      Archived workspace → 403 workspace-archived for practice-sessions / submit / self-grade /
//      my-state (implementation-plan §7: practice is a write).
//   A11 Short answers with accepted answers are auto-graded after NFKC, trim, whitespace
//      collapse and case folding; without accepted answers (null) they are pending like essays.
//   A12 A pending submission is not a graded result: the dot keeps `viewed` (or the previous
//      graded result), `is_pending_grading` is true and the label/tooltip says "채점 대기".
//   A13 QOV-01-AC01 "draft 10개": the only synthetic question paper yields 8 import drafts (A5);
//      the spec uses those 8 drafts, then publishes the 3 answered drafts 1, 4, 5 and expects
//      exactly +3 markers (questions.md §8: "그중 3개 승인하면 점 103개").
//
// UI contract (Korean first, English accepted; AGENTS.md §5):
//   QBANK-01  h1 "전체 문제" (UX6-BANK; was "문제은행"); empty-state heading "등록된 문제가 없습니다" with a "문제 직접 등록" button
//             and a "PDF 가져오기" button; header "PDF 가져오기"/"문제 등록" buttons only while the bank
//             has questions (UX4); "PDF 가져오기" opens the non-modal dialog "문제 PDF 관리" (same as
//             the home's); toggle button "검색·필터" (collapsed by default, UX4) controlling a group
//             "검색·필터" with searchbox "문제 검색" and comboboxes "유형", "챕터", "상태"; `?create=1`
//             opens the "문제 등록" editor once; one region per chapter named by the chapter
//             title (questions without one under "챕터 없음"), one listitem per question with
//             "편집" and a source link (pageLabel) into the document viewer. The editor is a
//             dialog "문제 등록"/"문제 편집" with radiogroup "문제 유형" (객관식/단답형/서술형),
//             textbox "문제 내용", textboxes "보기 N" + "보기 추가", per-option checkbox
//             "보기 N 정답", textbox "허용 답안" (short), "채점 기준" (essay), combobox "챕터",
//             button "저장"; errors in role=alert. Viewer / archived: no create/edit controls and
//             a "읽기 전용" notice.
//   QIMPORT-01 h1 "문제 PDF 가져오기"; no upload since UX6-UPLOAD (PDFs are uploaded in 문서 관리;
//             combobox "검토할 PDF" with two or more extracted PDFs; "문서 관리 열기" when none);
//             progressbar "가져오기" while the job runs; list "가져온 초안" with one listitem per draft showing "N번",
//             the stem, a page link (pageLabel) and "원본 비교" (opens a region/dialog "원본"
//             showing that page); "정답 없음" when the key has no answer; checkbox "승인"; "편집"
//             opens the same question editor; button "승인한 문제 등록" publishes; a failed
//             import job or publish shows role=alert + "다시 시도".
//   QOV-01    route /workspaces/{id} (the workspace home, UX3c); role=group "문제 heatmap" holding one button per
//             CONFIRMED question, named by questionDotLabel and carrying data-status; inside it the
//             marker svg data-testid="question-marker" with data-shape square|star (design-system
//             §6.1, packages/ui/src/questions); preview role=tooltip; collapsible group "상태 필터"
//             (toggle button "상태 필터", collapsed by default); no status summary or legend since
//             UX3c and no question count line since UX4.
//   QPLAY-01  modal dialog named by the question title (`… 12번 문제`) with "패널 닫기",
//             toggles "즐겨찾기 추가"/"즐겨찾기 해제" and "다시 풀기 표시"/"다시 풀기 해제" (M5.3
//             StudyToggles); MCQ options as radios (single) or checkboxes (multi) named by the
//             option text in displayed order; textbox "답안" (short/essay); button "제출"; the
//             graded result as text 정답/오답/채점 대기 (role=status); the explanation only after
//             submit; self-grade buttons "맞음"/"틀림"; "이전 문제"/"다음 문제". While open the URL
//             carries ?question=<id>; closing removes it and returns focus to the trigger dot.
import { copyFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { JOB_TIMEOUT_MS, PDF_DIR, uploadPdf, waitForJob, type PdfFile } from './documents.ts';
import { docUi, homePath, homeUi, main } from './workspace-ui.ts';
import type { Member } from './workspaces.ts';

// ---------------------------------------------------------------------------------------------
// Question paper fixture (tests/fixtures/pdfs/questions-ko.truth.json)
// ---------------------------------------------------------------------------------------------

export type QuestionType = 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';

export interface TruthQuestion {
  readonly number: number;
  readonly question_type: QuestionType;
  readonly multi_select: boolean;
  readonly stem: string;
  readonly options: readonly { readonly label: string; readonly text: string }[];
  readonly answer: {
    readonly correct_option_labels: readonly string[] | null;
    readonly accepted_answers: readonly string[] | null;
  } | null;
  readonly page: number;
}

export interface QuestionPaper extends PdfFile {
  readonly questions: readonly TruthQuestion[];
}

export function questionPaper(): QuestionPaper {
  const truth = JSON.parse(readFileSync(join(PDF_DIR, 'questions-ko.truth.json'), 'utf8')) as {
    file: string;
    sha256: string;
    questions: TruthQuestion[];
  };
  const path = join(PDF_DIR, truth.file);
  return {
    file: truth.file,
    path,
    sha256: truth.sha256,
    size: statSync(path).size,
    questions: truth.questions,
  };
}

/** A7: file-name marker that makes the APP_ENV=test fake extractor fail a run's first job. */
export const IMPORT_FAILURE_MARKER = 'E2E-FAIL-IMPORT-ONCE';

/** Same bytes as `paper`, copied to `dir` under a file name carrying IMPORT_FAILURE_MARKER. */
export function failingOnceCopy(paper: QuestionPaper, dir: string): QuestionPaper {
  const file = `questions-ko-${IMPORT_FAILURE_MARKER}.pdf`;
  const path = join(dir, file);
  copyFileSync(paper.path, path);
  return { ...paper, file, path };
}

export function truthQuestion(paper: QuestionPaper, n: number): TruthQuestion {
  const q = paper.questions.find((x) => x.number === n);
  if (!q) throw new Error(`questions-ko has no question ${n}`);
  return q;
}

// ---------------------------------------------------------------------------------------------
// API (A1–A4, A7)
// ---------------------------------------------------------------------------------------------

export interface QuestionOption {
  readonly id: string;
  readonly text: string;
}

export interface QuestionSource {
  readonly document_id: string;
  readonly page_start: number | null;
  readonly page_end: number | null;
}

export interface QuestionInput {
  readonly question_type: QuestionType;
  readonly stem: string;
  readonly options?: readonly QuestionOption[];
  readonly correct_option_ids?: readonly string[] | null;
  readonly is_multi_answer?: boolean;
  readonly accepted_answers?: readonly string[] | null;
  readonly explanation?: string | null;
  readonly rubric?: string | null;
  readonly chapter_id?: string | null;
  readonly sources?: readonly QuestionSource[];
  /** A9 (M5.0): the heatmap label number (`12번 문제`). */
  readonly question_number?: number;
}

export interface QuestionRevision {
  readonly id: string;
  readonly version: number;
  readonly stem: string;
  readonly options: readonly QuestionOption[];
  readonly correct_option_ids: readonly string[] | null;
  readonly accepted_answers: readonly string[] | null;
  readonly is_multi_answer: boolean;
  readonly explanation: string | null;
  readonly rubric: string | null;
}

export interface Question {
  readonly id: string;
  readonly workspace_id: string;
  readonly question_type: QuestionType;
  readonly publication_status: 'DRAFT' | 'CONFIRMED' | 'ARCHIVED';
  readonly chapter_id: string | null;
  readonly origin?: string;
  readonly revision: QuestionRevision;
  readonly sources: readonly QuestionSource[];
}

export interface ImportRun {
  readonly id: string;
  readonly status: string;
  readonly job_id: string;
  readonly source_document_id?: string;
}

export interface DraftPayload {
  readonly question_type: QuestionType;
  readonly stem: string;
  readonly options: readonly QuestionOption[];
  readonly correct_option_ids: readonly string[] | null;
  readonly accepted_answers: readonly string[] | null;
  readonly evidence: readonly {
    readonly document_id: string;
    readonly locations: readonly { readonly page: number }[];
  }[];
}

export interface Draft {
  readonly id: string;
  readonly position: number;
  readonly question_type: QuestionType;
  readonly review_status: 'pending' | 'approved' | 'rejected';
  readonly published_question_id: string | null;
  readonly validations: readonly { readonly code: string; readonly severity: string }[];
  readonly payload: DraftPayload;
  /** Optimistic-concurrency token: `base_version` when editing, `version` when publishing. */
  readonly version: string;
  /** CHAPTER-MAP: the book chapter the draft is registered under (suggested or chosen). */
  readonly chapter?: { readonly id: string; readonly title: string } | null;
  readonly chapter_choice?: 'auto' | 'manual';
}

/** Four-option MCQ with client-chosen option ids (A2); option `answer` (0-based) is correct. */
export function mcqInput(stem: string, texts: readonly string[], answer = 0): QuestionInput {
  const options = texts.map((text, i) => ({ id: `opt-${i + 1}`, text }));
  return {
    question_type: 'MCQ',
    stem,
    options,
    correct_option_ids: [options[answer]?.id ?? 'opt-1'],
    is_multi_answer: false,
  };
}

export async function createQuestion(
  owner: Member,
  workspaceId: string,
  input: QuestionInput,
): Promise<Question> {
  return owner.api.ok<Question>('POST', `/workspaces/${workspaceId}/questions`, input, [201]);
}

export async function listQuestions(
  member: Member,
  workspaceId: string,
  query = '',
): Promise<Question[]> {
  const body = await member.api.ok<{ items: Question[] }>(
    'GET',
    `/workspaces/${workspaceId}/questions${query ? `?${query}` : ''}`,
    undefined,
    [200],
  );
  return body.items;
}

export async function getQuestion(member: Member, id: string): Promise<Question> {
  return member.api.ok<Question>('GET', `/questions/${id}`, undefined, [200]);
}

export async function startImport(
  owner: Member,
  workspaceId: string,
  documentId: string,
  idempotencyKey?: string,
): Promise<ImportRun> {
  return owner.api.ok<ImportRun>(
    'POST',
    `/workspaces/${workspaceId}/question-imports`,
    { document_id: documentId },
    [202],
    idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
  );
}

export async function listImports(member: Member, workspaceId: string): Promise<ImportRun[]> {
  const body = await member.api.ok<{ items: ImportRun[] }>(
    'GET',
    `/workspaces/${workspaceId}/question-imports`,
    undefined,
    [200],
  );
  return body.items;
}

export async function listDrafts(member: Member, importId: string): Promise<Draft[]> {
  const body = await member.api.ok<{ items: Draft[] }>(
    'GET',
    `/question-imports/${importId}/drafts`,
    undefined,
    [200],
  );
  return [...body.items].sort((a, b) => a.position - b.position);
}

/** Options of a draft's chapter picker: "챕터 없음" + the workspace's book chapters (CHAPTER-MAP). */
export async function bookChapterOptions(member: Member, importId: string): Promise<number> {
  const body = await member.api.ok<{ chapters?: unknown[] }>(
    'GET',
    `/question-imports/${importId}/drafts`,
    undefined,
    [200],
  );
  return (body.chapters?.length ?? 0) + 1;
}

export async function getImport(member: Member, importId: string): Promise<ImportRun> {
  return member.api.ok<ImportRun>('GET', `/question-imports/${importId}`, undefined, [200]);
}

/** Polls the import run (no sleeps) until it reaches `status`. */
export async function waitForImportStatus(
  member: Member,
  importId: string,
  status: 'succeeded' | 'failed',
): Promise<ImportRun> {
  let run: ImportRun | undefined;
  await expect
    .poll(async () => (run = await getImport(member, importId)).status, {
      message: `import run reaches ${status}`,
      timeout: JOB_TIMEOUT_MS,
    })
    .toBe(status);
  if (!run) throw new Error('no import run');
  return run;
}

/** Waits for the newest import run of the workspace and its job; returns the run. */
export async function waitForLatestImport(member: Member, workspaceId: string): Promise<ImportRun> {
  let run: ImportRun | undefined;
  await expect
    .poll(async () => (run = (await listImports(member, workspaceId))[0]) !== undefined, {
      message: 'an import run exists',
      timeout: JOB_TIMEOUT_MS,
    })
    .toBe(true);
  if (!run) throw new Error('no import run');
  await waitForJob(member, run.job_id);
  return run;
}

/** Draft whose payload stem is the truth stem of question `n`. */
export function draftFor(drafts: readonly Draft[], q: TruthQuestion): Draft {
  const found = drafts.find((d) => d.payload.stem.includes(q.stem));
  if (!found) throw new Error(`no draft for question ${q.number}`);
  return found;
}

// ---------------------------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------------------------

export function bankPath(workspaceId: string): string {
  return `/workspaces/${workspaceId}/questions/bank`;
}

export function importPath(workspaceId: string): string {
  return `/workspaces/${workspaceId}/questions/import`;
}

const button = (scope: Page | Locator, name: RegExp) => scope.getByRole('button', { name });
const buttonOrLink = (scope: Page | Locator, name: RegExp) =>
  scope.getByRole('button', { name }).or(scope.getByRole('link', { name }));

export const bankUi = {
  heading: (page: Page) => page.getByRole('heading', { level: 1 }),
  emptyState: (page: Page) =>
    main(page).getByRole('heading', { name: /등록된 문제가 없|문제가 없|no questions/i }),
  createButton: (page: Page) =>
    button(main(page), /문제 (직접 )?(등록|추가)|새 문제|(add|new|create) question/i).first(),
  importButtons: (page: Page) => buttonOrLink(main(page), /^(pdf 가져오기|import pdf)$/i),
  importLink: (page: Page) => bankUi.importButtons(page).first(),
  /** "검색·필터" toggle (UX4: collapsed by default) and the group it controls. */
  filterToggle: (page: Page) =>
    main(page).getByRole('button', { name: /^(검색·필터|search (and|&) filters?)$/i }),
  filterGroup: (page: Page) =>
    main(page).getByRole('group', { name: /^(검색·필터|search (and|&) filters?)$/i }),
  pdfsDialog: (page: Page) =>
    page.getByRole('dialog', { name: /^(문제 pdf 관리|question pdfs?)$/i }),
  search: (page: Page) => main(page).getByRole('searchbox', { name: /문제 검색|검색|search/i }),
  typeFilter: (page: Page) => main(page).getByRole('combobox', { name: /^(문제 )?(유형|type)/i }),
  chapterFilter: (page: Page) => main(page).getByRole('combobox', { name: /^(장|챕터|chapter)/i }),
  chapterGroup: (page: Page, title: string | RegExp) =>
    main(page).getByRole('region', { name: title }),
  noChapterGroup: (page: Page) =>
    main(page).getByRole('region', { name: /챕터 없음|미분류|장 없음|no chapter|unassigned/i }),
  /** Question rows (inside the chapter groups; the page's breadcrumb is a list too). */
  items: (page: Page) => main(page).getByRole('region').getByRole('listitem'),
  item: (page: Page, stem: string) =>
    main(page).getByRole('region').getByRole('listitem').filter({ hasText: stem }),
  editButton: (item: Locator) => item.getByRole('button', { name: /^(편집|수정|edit)/i }),
  readOnlyNotice: (page: Page) =>
    main(page)
      .getByText(/읽기 전용|보관된 workspace|read-only|archived/i)
      .first(),
  alert: (page: Page) => main(page).getByRole('alert').or(page.getByRole('alert')).first(),
};

/** Opens the bank's "검색·필터" (no-op when it is open; UX4 collapses it by default). */
export async function openBankFilters(page: Page): Promise<void> {
  const toggle = bankUi.filterToggle(page);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(bankUi.filterGroup(page)).toBeVisible();
}

export const questionFormUi = {
  form: (page: Page) =>
    page.getByRole('dialog', { name: /문제 (등록|추가|편집|수정)|(new|add|edit) question/i }),
  type: (form: Locator, type: QuestionType) =>
    form.getByRole('radio', {
      name: {
        MCQ: /객관식|multiple choice|mcq/i,
        SHORT_ANSWER: /단답형?|주관식|short answer/i,
        ESSAY: /서술형|essay/i,
      }[type],
    }),
  stem: (form: Locator) => form.getByRole('textbox', { name: /문제 (내용|본문)|지문|stem/i }),
  option: (form: Locator, n: number) =>
    form.getByRole('textbox', { name: new RegExp(`^(보기|선택지|option) ${n}$`, 'i') }),
  addOption: (form: Locator) =>
    form.getByRole('button', { name: /(보기|선택지) 추가|add option/i }),
  correct: (form: Locator, n: number) => {
    const name = new RegExp(`(보기|선택지|option) ${n} (정답|correct)`, 'i');
    return form.getByRole('checkbox', { name }).or(form.getByRole('radio', { name }));
  },
  acceptedAnswers: (form: Locator) =>
    form.getByRole('textbox', { name: /허용 답안|정답|accepted answers?/i }),
  rubric: (form: Locator) =>
    form.getByRole('textbox', { name: /채점 기준|모범 답안|rubric|model answer/i }),
  chapter: (form: Locator) => form.getByRole('combobox', { name: /^(장|챕터|chapter)/i }),
  save: (form: Locator) => form.getByRole('button', { name: /^(저장|등록|save)/i }),
  alert: (form: Locator) => form.getByRole('alert'),
};

export const importUi = {
  heading: (page: Page) => page.getByRole('heading', { level: 1 }),
  progress: (page: Page) =>
    main(page).getByRole('progressbar', { name: /가져오기|추출|분석|import|extract/i }),
  /** UX6-UPLOAD: `검토할 PDF` (one review per PDF; shown with two or more extracted PDFs). */
  pdfSwitcher: (page: Page) =>
    main(page).getByRole('combobox', { name: /검토할 pdf|pdf to review/i }),
  /** UX6-UPLOAD: "문서 관리 열기" (empty import page and 문제 PDF 관리). */
  openDocuments: (scope: Locator) => buttonOrLink(scope, /문서 관리 열기|open documents/i),
  drafts: (page: Page) =>
    main(page).getByRole('list', { name: /가져온 (초안|문제)|초안|drafts?|imported questions/i }),
  draftItems: (page: Page) => importUi.drafts(page).getByRole('listitem'),
  draft: (page: Page, stem: string) => importUi.draftItems(page).filter({ hasText: stem }),
  number: (n: number) => new RegExp(`(?<!\\d)${n}\\s*번|(question|q)\\s*${n}(?!\\d)`, 'i'),
  noAnswer: (draft: Locator) => draft.getByText(/정답 없음|정답 미확인|정답 미지정|no answer/i),
  compare: (draft: Locator) =>
    buttonOrLink(draft, /원본 (비교|보기)|원문 (비교|보기)|compare|view source/i),
  sourceView: (page: Page) =>
    page
      .getByRole('region', { name: /^(원본|원문|source)/i })
      .or(page.getByRole('dialog', { name: /^(원본|원문|source)/i })),
  /** QIMP-BULK: a plain selection checkbox per draft ("N번 문제 선택"); nothing is sent on toggle. */
  select: (draft: Locator) => draft.getByRole('checkbox', { name: /선택|select/i }),
  /** "전체 선택 (n개)": every registrable draft of the run. */
  selectAll: (page: Page) => main(page).getByRole('checkbox', { name: /전체 선택|select all/i }),
  edit: (draft: Locator) => draft.getByRole('button', { name: /^(편집|수정|edit)/i }),
  publish: (page: Page) =>
    button(
      main(page),
      /선택한 (초안|문제|항목)?\s*승인 및 등록|(승인|선택)한? (초안|문제|항목)?\s*등록|approve and register|publish/i,
    ),
  retry: (page: Page) => button(main(page), /다시 시도|재시도|retry/i),
  alert: (page: Page) => main(page).getByRole('alert').first(),
  /** "가져온 초안 N개": the section heading with the run's draft count (all pages). */
  draftsHeading: (page: Page) =>
    main(page).getByRole('heading', {
      level: 2,
      name: /가져온 (초안|문제)|imported (drafts|questions)/i,
    }),
  /** QIMP-REVIEW-SCALE: the pager above the draft list (one page of drafts at a time). */
  pager: (page: Page) =>
    main(page).getByRole('navigation', { name: /^(초안 페이지|draft pages)$/i }),
  pagerPage: (pager: Locator, n: number) =>
    pager.getByRole('button', { name: new RegExp(`^${n}(페이지| page)$`, 'i') }),
};

/** Fills the open question editor with a single-answer MCQ (`correct` is 1-based, 0 = none). */
export async function fillMcq(
  page: Page,
  stem: string,
  options: readonly string[],
  correct: number,
): Promise<Locator> {
  const form = questionFormUi.form(page);
  await expect(form).toBeVisible();
  await questionFormUi.type(form, 'MCQ').check();
  await questionFormUi.stem(form).fill(stem);
  for (const [i, text] of options.entries()) {
    const field = questionFormUi.option(form, i + 1);
    if (!(await field.isVisible())) await questionFormUi.addOption(form).click();
    await field.fill(text);
  }
  if (correct > 0) await questionFormUi.correct(form, correct).check();
  return form;
}

/**
 * Uploads the question paper the way a user does since UX6-UPLOAD: through the home's "문서 관리"
 * dialog (one upload place, no type choice), then waits until the server classified it and started
 * its extraction and follows the row's "문제 검토" link to the import page (`?document=<id>`).
 */
export async function uploadQuestionPaper(
  page: Page,
  workspaceId: string,
  paper: QuestionPaper,
): Promise<void> {
  await page.goto(homePath(workspaceId, 'panel=documents'));
  const dialog = homeUi.documentsDialog(page);
  await expect(dialog).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await docUi.uploadButton(page).click();
  await (await chooser).setFiles(paper.path);
  const row = dialog.getByRole('listitem').filter({ hasText: paper.file.replace(/\.pdf$/, '') });
  const review = docUi.reviewLink(row);
  await expect(review).toBeVisible({ timeout: JOB_TIMEOUT_MS });
  await review.click();
  await expect(page).toHaveURL(
    (url) => url.pathname === importPath(workspaceId) && url.searchParams.has('document'),
  );
}

// ---------------------------------------------------------------------------------------------
// Overview + practice API (A8–A13, M5.0)
// ---------------------------------------------------------------------------------------------

export type DotStatus = 'unseen' | 'viewed' | 'incorrect' | 'correct' | 'retry';

export interface OverviewItem {
  readonly question_id: string;
  readonly chapter_id: string | null;
  readonly question_number: number | null;
  readonly question_type: QuestionType;
  readonly status: DotStatus;
  readonly is_favorite: boolean;
  readonly needs_retry: boolean;
  readonly last_graded_result: 'correct' | 'incorrect' | null;
  readonly is_pending_grading: boolean;
  readonly preview: string;
}

export interface Overview {
  readonly counts: Readonly<Record<DotStatus | 'total' | 'favorite', number>>;
  readonly chapters: readonly {
    readonly id: string | null;
    readonly number: number | null;
    readonly title: string;
  }[];
  readonly items: readonly OverviewItem[];
}

export interface PracticeSession {
  readonly id: string;
  readonly question_id: string;
  readonly question_revision_id: string;
  readonly question_type: QuestionType;
  readonly stem: string;
  readonly is_multi_answer: boolean;
  readonly options: readonly QuestionOption[];
  readonly state: string;
}

export interface SubmitResult {
  readonly attempt_id: string;
  readonly result: 'correct' | 'incorrect' | 'pending';
  readonly correct_option_ids: readonly string[] | null;
  readonly explanation: string | null;
}

export interface Attempt {
  readonly id: string;
  readonly question_revision_id: string;
  readonly practice_session_id: string;
  readonly displayed_option_ids: readonly string[];
  readonly submitted_answer: {
    readonly selected_option_ids?: readonly string[];
    readonly answer_text?: string;
  };
  readonly result: 'correct' | 'incorrect' | 'pending';
  readonly grading_method: 'auto' | 'self' | 'reviewer' | null;
  readonly grades_attempt_id: string | null;
}

/** Fields a practice payload must never carry before submission (A10, e2e-strategy §6). */
export const ANSWER_KEYS: readonly string[] = [
  'correct_option_ids',
  'accepted_answers',
  'explanation',
  'rubric',
  'correct_answer',
];

/** Every ANSWER_KEYS key found anywhere in a parsed JSON value, as `$.path.to.key`. */
export function answerKeysIn(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => answerKeysIn(v, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, v]) => [
    ...(ANSWER_KEYS.includes(key) ? [`${path}.${key}`] : []),
    ...answerKeysIn(v, `${path}.${key}`),
  ]);
}

export async function getOverview(member: Member, workspaceId: string): Promise<Overview> {
  return member.api.ok<Overview>(
    'GET',
    `/workspaces/${workspaceId}/questions/overview`,
    undefined,
    [200],
  );
}

export async function overviewItem(
  member: Member,
  workspaceId: string,
  questionId: string,
): Promise<OverviewItem> {
  const item = (await getOverview(member, workspaceId)).items.find(
    (i) => i.question_id === questionId,
  );
  if (!item) throw new Error('question missing from the overview');
  return item;
}

export async function startPractice(member: Member, questionId: string): Promise<PracticeSession> {
  return member.api.ok<PracticeSession>(
    'POST',
    `/questions/${questionId}/practice-sessions`,
    {},
    [201],
  );
}

export async function submitPractice(
  member: Member,
  sessionId: string,
  answer: { selected_option_ids: readonly string[] } | { answer_text: string },
): Promise<SubmitResult> {
  return member.api.ok<SubmitResult>(
    'POST',
    `/practice-sessions/${sessionId}/submit`,
    answer,
    [200],
  );
}

export async function setMyState(
  member: Member,
  questionId: string,
  state: { is_favorite?: boolean; needs_retry?: boolean },
): Promise<void> {
  await member.api.ok('PATCH', `/questions/${questionId}/my-state`, state, [200]);
}

export async function listAttempts(member: Member, questionId: string): Promise<Attempt[]> {
  const body = await member.api.ok<{ items: Attempt[] }>(
    'GET',
    `/questions/${questionId}/attempts`,
    undefined,
    [200],
  );
  return body.items;
}

/** Practises `question` once through the API and answers it correctly (auto-graded MCQ). */
export async function answerCorrectly(member: Member, question: Question): Promise<void> {
  const session = await startPractice(member, question.id);
  const ids = question.revision.correct_option_ids ?? [];
  const graded = await submitPractice(member, session.id, { selected_option_ids: ids });
  if (graded.result !== 'correct')
    throw new Error(`expected a correct grade, got ${graded.result}`);
}

/** MCQ numbered `n` (A9) whose option texts are unique to `label`; option `answer` is correct. */
export function numberedMcq(
  label: string,
  n: number,
  answer = 0,
  extra: Partial<QuestionInput> = {},
): QuestionInput {
  const tag = `${label}-${n}`;
  const texts = ['가', '나', '다', '라'].map((x) => `${tag} 보기 ${x}`);
  return {
    ...mcqInput(`${tag} 문제: 알맞은 것을 고르시오.`, texts, answer),
    question_number: n,
    ...extra,
  };
}

/** Creates numbered MCQs 1..count in parallel batches of 10; returns them in number order. */
export async function createNumberedQuestions(
  owner: Member,
  workspaceId: string,
  label: string,
  count: number,
): Promise<Question[]> {
  const out: Question[] = [];
  for (let start = 1; start <= count; start += 10) {
    const batch = Array.from({ length: Math.min(10, count - start + 1) }, (_, i) => start + i);
    const created = await Promise.all(
      batch.map((n) => createQuestion(owner, workspaceId, numberedMcq(label, n))),
    );
    out.push(...created);
  }
  return out;
}

/** Imports questions-ko.pdf through the public API (A4); returns the run and its drafts (A13). */
export async function importPaperDrafts(
  owner: Member,
  workspaceId: string,
): Promise<{ run: ImportRun; drafts: Draft[] }> {
  const { documentId, jobId } = await uploadPdf(
    owner,
    workspaceId,
    questionPaper(),
    'question_paper',
  );
  await waitForJob(owner, jobId);
  const run = await startImport(owner, workspaceId, documentId);
  await waitForJob(owner, run.job_id);
  return { run, drafts: await listDrafts(owner, run.id) };
}

/**
 * Registers drafts the way a reviewer does (A4): approve each one at its current version
 * (`PATCH /question-drafts/{id}`), then publish exactly those drafts at the approved versions.
 */
export async function publishDrafts(
  owner: Member,
  importId: string,
  draftIds: readonly string[],
): Promise<void> {
  const current = new Map((await listDrafts(owner, importId)).map((d) => [d.id, d]));
  const drafts: { draft_id: string; version: string }[] = [];
  for (const id of draftIds) {
    const draft = current.get(id);
    if (!draft) throw new Error(`draft ${id} is not part of import ${importId}`);
    const approved = await owner.api.ok<Draft>(
      'PATCH',
      `/question-drafts/${id}`,
      { base_version: draft.version, review_status: 'approved' },
      [200],
    );
    drafts.push({ draft_id: id, version: approved.version });
  }
  await owner.api.ok('POST', `/question-imports/${importId}/publish`, { drafts }, [200]);
}

// ---------------------------------------------------------------------------------------------
// Overview / practice panel UI (QOV-01, QPLAY-01)
// ---------------------------------------------------------------------------------------------

/** The workspace home = the heatmap (UX3c; `/questions` redirects here). */
export function overviewPath(workspaceId: string, questionId?: string): string {
  const base = `/workspaces/${workspaceId}`;
  return questionId ? `${base}?question=${questionId}` : base;
}

/** `12번 문제` not preceded by another digit (so `2번` never matches `12번`). */
export function questionNumberName(n: number): RegExp {
  return new RegExp(`(?<!\\d)${n}번 문제|question ${n}(?!\\d)`, 'i');
}

export const overviewUi = {
  heatmap: (page: Page) => main(page).getByRole('group', { name: /문제 heatmap|heatmap/i }),
  /** The question markers (chapter headers also hold a `<장 제목> 정리 노트` button, CHNOTE-01). */
  dots: (page: Page) =>
    overviewUi.heatmap(page).getByRole('button', { name: /\d+번 문제|question \d+/i }),
  dot: (page: Page, n: number) =>
    overviewUi.heatmap(page).getByRole('button', { name: questionNumberName(n) }),
  markers: (page: Page) => overviewUi.heatmap(page).getByTestId('question-marker'),
  marker: (dot: Locator) => dot.getByTestId('question-marker'),
  tooltip: (page: Page) => page.getByRole('tooltip'),
  /** The removed count line "현재 필터의 문제 n개" (UX4): must not come back. */
  inFilter: (page: Page) =>
    main(page).getByText(/현재 필터의 문제 \d+개|\d+ questions in (the )?filter/i),
};

export const panelUi = {
  panel: (page: Page) => page.getByRole('dialog', { name: /번 문제|question \d/i }),
  numbered: (page: Page, n: number) => page.getByRole('dialog', { name: questionNumberName(n) }),
  close: (panel: Locator) => panel.getByRole('button', { name: /패널 닫기|^닫기$|^close/i }),
  favoriteOn: (panel: Locator) =>
    panel.getByRole('button', { name: /즐겨찾기 추가|add (to )?favorites?/i }),
  favoriteOff: (panel: Locator) =>
    panel.getByRole('button', { name: /즐겨찾기 해제|remove (from )?favorites?/i }),
  retryOn: (panel: Locator) =>
    panel.getByRole('button', { name: /다시 풀기 표시|mark (for )?retry/i }),
  retryOff: (panel: Locator) => panel.getByRole('button', { name: /다시 풀기 해제|clear retry/i }),
  option: (panel: Locator, text: string) =>
    panel
      .getByRole('radio', { name: text, exact: true })
      .or(panel.getByRole('checkbox', { name: text, exact: true })),
  options: (panel: Locator) => panel.getByRole('radio').or(panel.getByRole('checkbox')),
  answerText: (panel: Locator) => panel.getByRole('textbox', { name: /답안|answer/i }),
  submit: (panel: Locator) => panel.getByRole('button', { name: /^(답안 )?제출|^submit/i }),
  result: (panel: Locator) => panel.getByRole('status'),
  selfGradeCorrect: (panel: Locator) =>
    panel.getByRole('button', { name: /^(맞음|맞았|정답으로|correct)/i }),
  selfGradeIncorrect: (panel: Locator) =>
    panel.getByRole('button', { name: /^(틀림|틀렸|오답으로|incorrect)/i }),
  next: (panel: Locator) => panel.getByRole('button', { name: /다음 문제|^next/i }),
  previous: (panel: Locator) => panel.getByRole('button', { name: /이전 문제|^previous/i }),
};

export const RESULT_TEXT = {
  correct: /정답|(?<!in)correct/i,
  incorrect: /오답|틀렸|incorrect/i,
  pending: /채점 대기|pending/i,
} as const;

/** Computed `color` of the `--question-status-<status>` token as the browser resolves it. */
export async function statusColor(page: Page, status: DotStatus): Promise<string> {
  return page.evaluate((s) => {
    const probe = document.createElement('span');
    probe.style.color = `var(--question-status-${s})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, status);
}

/** Uniform scale factor of an element's computed transform (1 when none). */
export async function scaleOf(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const t = getComputedStyle(el).transform;
    return !t || t === 'none' ? 1 : new DOMMatrixReadOnly(t).a;
  });
}
