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
//   A4 Question PDF import reuses the document upload flow (documents.ts `uploadPdf`), then
//      POST /workspaces/{id}/question-imports {document_id} (+ optional `Idempotency-Key`
//           header: same key → same run) → 202 ImportRun
//      GET  /workspaces/{id}/question-imports → 200 {items: ImportRun[]}  (newest first; the
//           runs table has a (workspace_id, created_at desc) index for this listing)
//      GET  /question-imports/{id}            → 200 ImportRun
//      GET  /question-imports/{id}/drafts     → 200 {items: Draft[]} ordered by position
//      POST /question-imports/{id}/publish {draft_ids} → 200 {items: [{draft_id, question_id}]}
//           approves + publishes exactly those drafts; idempotent per draft (unique
//           published_question_id); an unedited MCQ draft without an answer → 422.
//      ImportRun = {id, status, job_id, source_document_id}; the job is polled at GET /jobs/{id}.
//      Draft = {id, position, question_type, review_status, published_question_id, validations,
//               payload: QuestionDraft (book_core schema_version 1)}
//   A5 QIMPORT-01-AC01 says "a PDF with 5 questions → 5 drafts"; the only synthetic question
//      paper (tests/fixtures/pdfs/questions-ko.pdf, M1.1) has 8, so the tests expect one draft per
//      truth question (8). Its key covers 1, 2, 4, 5, 8: questions 3 (MCQ), 6 (short), 7 (essay)
//      have no answer.
//   A6 "Heatmap marker +N" (QIMPORT-01-AC03) is asserted as +N CONFIRMED questions in the bank
//      (questions.md §3.1: one marker = one CONFIRMED question); the heatmap UI/overview API is
//      QOV-01 (M5).
//
// UI contract (Korean first, English accepted; AGENTS.md §5):
//   QBANK-01  h1 "문제은행"; empty-state heading "등록된 문제가 없습니다" with a "문제 직접 등록" button
//             and a "PDF 가져오기" link to /questions/import; header "문제 등록" button; searchbox
//             "문제 검색"; comboboxes "유형" and "챕터"; one region per chapter named by the chapter
//             title (questions without one under "챕터 없음"), one listitem per question with
//             "편집" and a source link (pageLabel) into the document viewer. The editor is a
//             dialog "문제 등록"/"문제 편집" with radiogroup "문제 유형" (객관식/단답형/서술형),
//             textbox "문제 내용", textboxes "보기 N" + "보기 추가", per-option checkbox
//             "보기 N 정답", textbox "허용 답안" (short), "채점 기준" (essay), combobox "챕터",
//             button "저장"; errors in role=alert. Viewer / archived: no create/edit controls and
//             a "읽기 전용" notice.
//   QIMPORT-01 h1 "문제 PDF 가져오기"; "PDF 업로드" button (file chooser); progressbar "가져오기"
//             while the job runs; list "가져온 초안" with one listitem per draft showing "N번",
//             the stem, a page link (pageLabel) and "원본 비교" (opens a region/dialog "원본"
//             showing that page); "정답 없음" when the key has no answer; checkbox "승인"; "편집"
//             opens the same question editor; button "승인한 문제 등록" publishes; a failed
//             publish shows role=alert + "다시 시도".
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { JOB_TIMEOUT_MS, PDF_DIR, waitForJob, type PdfFile } from './documents.ts';
import { main } from './workspace-ui.ts';
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

export function truthQuestion(paper: QuestionPaper, n: number): TruthQuestion {
  const q = paper.questions.find((x) => x.number === n);
  if (!q) throw new Error(`questions-ko has no question ${n}`);
  return q;
}

// ---------------------------------------------------------------------------------------------
// API (A1–A4)
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
  importLink: (page: Page) =>
    buttonOrLink(main(page), /pdf (가져오기|import)|문제 pdf|import (from )?pdf/i).first(),
  search: (page: Page) => main(page).getByRole('searchbox', { name: /문제 검색|검색|search/i }),
  typeFilter: (page: Page) => main(page).getByRole('combobox', { name: /^(문제 )?(유형|type)/i }),
  chapterFilter: (page: Page) => main(page).getByRole('combobox', { name: /^(장|챕터|chapter)/i }),
  chapterGroup: (page: Page, title: string | RegExp) =>
    main(page).getByRole('region', { name: title }),
  noChapterGroup: (page: Page) =>
    main(page).getByRole('region', { name: /챕터 없음|미분류|장 없음|no chapter|unassigned/i }),
  items: (page: Page) => main(page).getByRole('listitem'),
  item: (page: Page, stem: string) => main(page).getByRole('listitem').filter({ hasText: stem }),
  editButton: (item: Locator) => item.getByRole('button', { name: /^(편집|수정|edit)/i }),
  readOnlyNotice: (page: Page) =>
    main(page)
      .getByText(/읽기 전용|보관된 workspace|read-only|archived/i)
      .first(),
  alert: (page: Page) => main(page).getByRole('alert').or(page.getByRole('alert')).first(),
};

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
  uploadButton: (page: Page) =>
    button(main(page), /pdf (업로드|선택)|파일 선택|업로드|upload|choose (a )?(pdf|file)/i).first(),
  progress: (page: Page) =>
    main(page).getByRole('progressbar', { name: /가져오기|추출|분석|import|extract/i }),
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
  approve: (draft: Locator) => draft.getByRole('checkbox', { name: /승인|approve/i }),
  edit: (draft: Locator) => draft.getByRole('button', { name: /^(편집|수정|edit)/i }),
  publish: (page: Page) =>
    button(main(page), /(승인|선택)한? (초안|문제|항목)?\s*등록|publish|register approved/i),
  retry: (page: Page) => button(main(page), /다시 시도|재시도|retry/i),
  alert: (page: Page) => main(page).getByRole('alert').first(),
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

/** Uploads the question paper through the import screen's file chooser. */
export async function uploadQuestionPaper(page: Page, paper: QuestionPaper): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await importUi.uploadButton(page).click();
  await (await chooser).setFiles(paper.path);
}
