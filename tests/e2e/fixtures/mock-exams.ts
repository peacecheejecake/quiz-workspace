// Mock exam (MOCK-01) fixtures: the mock exam API helpers, the APP_ENV=test batched scenario LLM
// (sources, hold barrier, call counts), the LLM-off stack and the MOCK-01 UI label contract.
// MOCK.0 keeps every assumption about MOCK-B / MOCK-P / MOCK-W in this header (mirrored by
// tests/integration/questions/mock_exams/test_mock_exams_contract.py); a deliberate change is a
// one-place edit here.
//
// Grounded in the docs (docs/screens/mock-exams.md, docs/questions.md §11, docs/architecture.md
// §5–§6): routes GET/POST /workspaces/{id}/mock-exams, GET/PATCH/DELETE /mock-exams/{id},
// POST /mock-exams/{id}/generations, GET /mock-exams/{id}/questions (`include=answers` for
// editors), PATCH/DELETE /mock-exam-questions/{id}, POST /mock-exam-questions/{id}/practice-
// sessions, POST /mock-practice-sessions/{id}/submit; job `mock_exam.generate {generation_id}`
// whose result holds counts, usage and an error code only; generation statuses queued | running |
// succeeded | partial | failed | cancelled; error codes llm_unavailable | llm_timeout |
// no_valid_questions | mock_exam_unavailable; problems no-matching-questions, range-invalid,
// mock-generation-running, generation-busy, mock-llm-disabled, workspace-archived,
// insufficient-role; settings WORKER_MOCK_EXAMS, MOCK_EXAM_MAX_PROMPT_TOKENS (60,000),
// MOCK_EXAM_MAX_OUTPUT_TOKENS (16,000), MOCK_EXAM_SOURCES_PER_CALL (40),
// MOCK_EXAM_GENERATION_CONCURRENCY (2), MOCK_EXAM_MAX_RUNNING_PER_WORKSPACE (5),
// MOCK_EXAM_GENERATION_RATE_LIMIT_PER_MINUTE (6); the range shape of QVIEW-01-C01
// (`{all, chapter_ids[], question_ids[], excluded_question_ids[], filters}`).
//
// NOT in the docs (MOCK.0 assumptions, to confirm or change in MOCK-B / MOCK-P / MOCK-W):
//   K1 MockExam = {id, workspace_id, title, version, status: generating|ready|partial|failed,
//      config: {variation_types: VariationType[1..4], question_count: int|null (null = 범위
//      전체, OPTION_SHUFFLE only), difficulty: easy|medium|hard|null (null = 원본과 같게)},
//      range: QuestionRange, question_count_current: int (current generation, removed excluded),
//      current_generation: Generation|null (the one whose questions are shown),
//      latest_generation: Generation|null (the newest, any status), created_at, updated_at}.
//      `status` = generating while latest_generation is queued/running, else ready / partial /
//      failed from latest_generation (failed keeps current_generation, the earlier questions).
//      Generation = {id, version, status, job_id, requested_count, created_count, skipped_count,
//      error_code: string|null, progress: {done, total}|null, seed, created_at, finished_at}.
//      GET /workspaces/{id}/mock-exams → 200 {llm_available: bool, items: MockExam[]} newest
//      first, any member (archived too); `llm_available` = this environment can run the AI types
//      (WORKER_MOCK_EXAMS on and an LLM, the scenario fake under APP_ENV=test).
//   K2 POST /workspaces/{id}/mock-exams {title, config, range, seed?: int} (optional
//      `Idempotency-Key`; same key → the same mock exam and generation) → 202 MockExam with a
//      queued first generation. POST /mock-exams/{id}/generations {config?, range?} (optional
//      `Idempotency-Key`) → 202 MockExam: 설정 바꾸기 sends the new config/range here (a new
//      mock_exam_revisions row and a new generation), 다시 만들기 / 다시 시도 an empty body.
//      PATCH /mock-exams/{id} {title} → 200 MockExam (rename only). DELETE → 204 (soft delete;
//      cancels a running generation). Problems are RFC 9457 `urn:quiz-workspace:problem:<slug>`.
//   K3 GET /mock-exams/{id}/questions[?include=answers] → 200 {items: MockExamQuestion[]} of
//      current_generation by position, removed ones excluded. MockExamQuestion = {id, position,
//      question_type, variation_type, stem, options: [{id, text}], is_multi_answer, revision:
//      {id, version}, edited: bool, source: {question_id: string|null, label: "<n>장 <m>번" |
//      "<m>번" | "원본 삭제됨"}} + editors with include=answers only: {correct_option_ids,
//      accepted_answers, explanation, rubric, validation_issues: [{code, severity}]} (a viewer's
//      include=answers is either 403 or the same answer-free list). PATCH /mock-exam-questions/
//      {id} {base_revision_id, stem?, options?, correct_option_ids?, is_multi_answer?,
//      explanation?} → 200 MockExamQuestion with answers (a new revision, edited: true). DELETE →
//      204 (removed_at). Practice (MOCK-P): POST /mock-exam-questions/{id}/practice-sessions {} →
//      201 {id, mock_exam_question_id, revision_id, question_type, stem, options (displayed
//      order), is_multi_answer} without answers; POST /mock-practice-sessions/{id}/submit
//      {selected_option_ids} | {answer_text} → 200 {attempt_id, result, correct_option_ids,
//      explanation}.
//   K4 Batched prompt (`mock_exam.generate`, `mock_exam.generate/v1`): one LLM call = one batch.
//      Each source of the batch is a block tagged S1..Sn holding the source stem verbatim (so
//      its bracketed ` [E2E-MOCK-…]` markers reach the fake) and a line `variation_type:
//      <VARIATION_TYPE>`; each passage appears once, tagged P1..Pk. Output: {items: [{source_tag,
//      variation_type, question_type, multi_select, stem, options: [{label, text}],
//      correct_option_labels, accepted_answers, explanation, justification, citations:
//      [{passage_id, quote}]}]} (a LLMVariant per item + source_tag / variation_type).
//   K5 Fake LLM (APP_ENV=test only): the worker answers `mock_exam.generate` from the
//      `mock_exam` block of tests/fixtures/llm/generation-scenarios.json (its description says
//      how: one item per source of the request from `sources.<key>.items.<VARIATION_TYPE>` or a
//      template, `source_tag` and citation passage tags filled in, the same request always gets
//      the same answer, faults `malformed` / `truncated` (requests over `sources_over` sources) /
//      `unavailable`). It records every call: in-process `calls: list[(markers, LLMRequest)]`
//      and `max_in_flight` (contract tests); in E2E the call count is the job result's
//      `usage.llm_calls` (GET /jobs/{job_id} → {status, result: {created_count, skipped_count,
//      usage: {llm_calls, batches, input_tokens?, output_tokens?}, error_code}}).
//   K6 Hold barrier (E2E): a source stem that also ends with ` [E2E-MOCK-HOLD-<token>]` makes the
//      fake create `<hold dir>/<token>.held` when a request carries it and wait (≤ 120 s) until
//      `<token>.release` exists. Hold dir = WORKER_MOCK_EXAM_HOLD_DIR, default `<system temp
//      dir>/quiz-e2e-mock-exam-hold` (the same for Node and Python processes of one machine, as
//      e2e:log-audit starts them). The generation is `running` with progress {done: 0, total}
//      while held.
//   K7 Crash fault (contract C09-6): `E2E-MOCK-CRASH-<token>` raises MockExamSimulatedCrash
//      once per token (file `<WORKER_MOCK_EXAM_FAULT_DIR>/<token>.crashed`, default `<system temp
//      dir>/quiz-e2e-mock-exam-faults`).
//   K8 LLM-off stack (MOCK-01-AC08): summary.ts startSummaryOffStack({WORKER_MOCK_EXAMS:
//      'false'}) — API, worker and web on free ports with a claimed Redis DB (D8). The main E2E
//      stack runs with WORKER_MOCK_EXAMS=true for its API and worker (export it before
//      `pnpm e2e:log-audit`; e2e-log-audit.ts / CI defaults are added with the phase, QGEN-RM).
//   K9 Status/labels: generating → "만드는 중", ready → "준비됨", partial → "일부만 만듦",
//      failed → "실패"; variation type names as QGEN-01 (`보기 섞기` · `문구 변형` · `정오 반전`
//      · `유사 개념`).
//
// UI contract (Korean first, English accepted; AGENTS.md §5):
//   `문제` menu (portalled) menuitem "모의고사" (requiresEdit false). Dialog: non-modal
//   FloatingSidePanel inside <main> named "모의고사" (`?panel=mock-exams[&mock=new|<id>]`), close
//   button "모의고사 닫기"; while loading `[aria-busy="true"]` + status "불러오는 중"; each view's
//   title is a heading that gets focus (list: "모의고사", create: "모의고사 만들기", detail: the
//   mock exam's name); BackLink "모의고사 목록" on create/detail.
//   List: text "모의고사 n개", button "추가" (editors of active workspaces only), list "모의고사
//   목록" with one listitem per mock exam: button named by the title (opens the detail), status
//   badge text, meta "문제 n개 · <유형, …> · <시각>", button "풀기" (ready/partial), menu button
//   "<이름> 메뉴" (editors) with menuitems 이름 바꾸기 / 설정 바꾸기 / 삭제; progressbar "문제 생성
//   진행률" (value text "n개 중 k개") while generating. Empty: "아직 모의고사가 없습니다." (+ the hint
//   for editors). Rename: inline textbox "모의고사 이름" (Enter saves, Escape cancels).
//   Create / 설정 바꾸기: step list "풀기 단계" with 옵션 → 범위; step 1 textbox "이름",
//   group "변형 유형" with four checkboxes (an unavailable one is disabled and described by
//   "이 환경에서는 AI 변형을 쓸 수 없습니다."), spinbutton "문항 수", combobox "난이도", button "다음";
//   step 2 QuestionRangePicker (shared with QVIEW-01; labels in fixtures/range-picker.ts: "전체
//   선택", chapter checkboxes by title — "챕터 없음" for questions without one — with "<장 제목>
//   펼치기", question checkboxes "<n>장 <m>번 · …", "선택 n문제", the "상태 필터" chips incl.
//   "즐겨찾기만"), text "선택 n문제 중 m문항을 만듭니다", the AI
//   notice "…AI 서비스로 전송됩니다.", buttons "이전" and "만들기" (설정 바꾸기: "다시 만들기"), disabled
//   and described by "출제 범위를 고르세요" when nothing is selected; "아직 확정된 문제가 없습니다."
//   Detail: heading (name), badge, meta with "<k>회차", buttons 풀기 · 설정 바꾸기 · 다시 만들기 ·
//   이름 바꾸기 · 삭제 (editors), alert "모의고사를 만들지 못했습니다" + reason + "다시 시도", partial text
//   "n문항 중 k문항을 만들었습니다. j개는 검증을 통과하지 못했습니다.", status text "문제를 만드는
//   중입니다. 창을 닫아도 계속 만듭니다.", list "문제 목록" with one listitem per question ("문제 k ·
//   <발문 앞 40자>", variation badge, source "n장 m번" / "원본 삭제됨", "편집됨" / "확인 필요"
//   badges for editors); a row is a button that opens QuestionViewer `manage` (modal dialog named
//   "문제 k") with the answer, explanation, buttons "편집" (the 문제 편집 fields of
//   questions.ts questionFormUi in a dialog "문제 편집") and "이 모의고사에서 빼기"; viewers get an
//   answer-free preview. Confirm dialogs are alertdialogs ("…삭제할까요?", "…바꿉니다…",
//   "…빼기…") with a confirm button. Not found: "모의고사를 찾을 수 없습니다.".
//   풀기 opens QuestionViewer `sequence(mock)` (`?practice=new&source=mock&mock=<id>`, a modal
//   dialog whose range step is titled "<이름> 풀기" and whose positions are titled "문제 k" —
//   QVIEW-01 "the title names the question"; MOCK-W corrected the MOCK.0 assumption of one title).
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import type { ApiResponse } from './api.ts';
import { JOB_TIMEOUT_MS } from './documents.ts';
import { REPO_ROOT } from './local-env.ts';
import type { DotStatus, QuestionInput, QuestionOption, QuestionType } from './questions.ts';
import { startSummaryOffStack, type SummaryOffStack } from './summary.ts';
import { main } from './workspace-ui.ts';
import type { Member } from './workspaces.ts';

const SCENARIO_FILE = join(REPO_ROOT, 'tests/fixtures/llm/generation-scenarios.json');

export const MOCK_JOB_TYPE = 'mock_exam.generate';
export const MOCK_TIMEOUT_MS = JOB_TIMEOUT_MS;
export const PROBLEM = 'urn:quiz-workspace:problem:';
export const MOCK_PROBLEMS = {
  noMatching: `${PROBLEM}no-matching-questions`,
  rangeInvalid: `${PROBLEM}range-invalid`,
  running: `${PROBLEM}mock-generation-running`,
  busy: `${PROBLEM}generation-busy`,
  llmDisabled: `${PROBLEM}mock-llm-disabled`,
  archived: `${PROBLEM}workspace-archived`,
  insufficientRole: `${PROBLEM}insufficient-role`,
} as const;

export type VariationType =
  'OPTION_SHUFFLE' | 'PARAPHRASE' | 'INVERT_POLARITY' | 'ANALOGOUS_CONCEPT';
export type GenerationStatus =
  'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
export type MockStatus = 'generating' | 'ready' | 'partial' | 'failed';

// ---------------------------------------------------------------------------------------------
// Scenario sources (K4–K6)
// ---------------------------------------------------------------------------------------------

/** Named sources of the `mock_exam` block (tests/fixtures/llm/generation-scenarios.json). */
export type MockSourceName =
  | 'evaporation'
  | 'condensation'
  | 'precipitation'
  | 'infiltration'
  | 'flocculation'
  | 'disinfection'
  | 'inv-runoff'
  | 'inv-filtration'
  | 'inv-multi'
  | 'brk-sediment'
  | 'brk-backwash'
  | 'brk-cloud'
  | 'brk-snow'
  | 'trn-raw-water'
  | 'fail-quote'
  | 'fail-answer'
  | 'down-chlorine'
  | 'down-raw';

interface ScriptedItem {
  readonly stem: string;
  readonly options: readonly { readonly label: string; readonly text: string }[];
  readonly correct_option_labels: readonly string[];
}

export interface MockSource {
  readonly marker: string;
  /** 1 = '1장 물의 순환', 2 = '2장 정수 처리', null = no chapter. */
  readonly chapter: 1 | 2 | null;
  readonly question_type: 'MCQ';
  readonly stem: string;
  readonly options: readonly QuestionOption[];
  readonly correct_option_ids: readonly string[];
  readonly is_multi_answer: boolean;
  readonly explanation: string | null;
  readonly source_page: number;
  readonly items: Readonly<Partial<Record<VariationType, ScriptedItem>>>;
}

interface MockBlock {
  readonly sources: Readonly<Record<MockSourceName, MockSource>>;
}

function mockBlock(): MockBlock {
  return (JSON.parse(readFileSync(SCENARIO_FILE, 'utf8')) as { mock_exam: MockBlock }).mock_exam;
}

export function mockSource(name: MockSourceName): MockSource {
  return mockBlock().sources[name];
}

/** The six sources of AC02–AC06 (1장 4, 2장 2), each scripted for 문구 변형 and 정오 반전. */
export const NORMAL_SOURCES: readonly MockSourceName[] = [
  'evaporation',
  'condensation',
  'precipitation',
  'infiltration',
  'flocculation',
  'disinfection',
];

/** Stems the fake answers with for `name` (every scripted variation type). */
export function scriptedStems(name: MockSourceName): string[] {
  return Object.values(mockSource(name).items).map((i) => i.stem);
}

export const CH1 = '1장 물의 순환';
export const CH2 = '2장 정수 처리';
/** The picker's group of questions without a chapter (the Heatmap's "챕터 없음"). */
export const NO_CHAPTER = '챕터 없음';

/**
 * CONFIRMED question input for scenario source `name`: the stem ends with ` [<marker>]` (K5)
 * plus the hold marker (K6) when given; numbered `n`, filed under `chapterId`, citing the
 * source's page of `documentId`.
 */
export function mockSourceInput(
  name: MockSourceName,
  documentId: string,
  n: number,
  chapterId: string | null,
  hold?: MockHold,
): QuestionInput {
  const s = mockSource(name);
  const tail = hold ? ` [${hold.marker}]` : '';
  return {
    question_type: s.question_type,
    stem: `${s.stem} [${s.marker}]${tail}`,
    options: s.options,
    correct_option_ids: s.correct_option_ids,
    is_multi_answer: s.is_multi_answer,
    explanation: s.explanation,
    question_number: n,
    chapter_id: chapterId,
    sources: [{ document_id: documentId, page_start: s.source_page, page_end: s.source_page }],
  };
}

export function mockHoldDir(): string {
  return process.env.WORKER_MOCK_EXAM_HOLD_DIR?.trim() || join(tmpdir(), 'quiz-e2e-mock-exam-hold');
}

/** K6 hold barrier: one token per test. */
export class MockHold {
  readonly token = randomUUID().replace(/-/g, '').slice(0, 16);
  readonly marker = `E2E-MOCK-HOLD-${this.token}`;

  /** Waits until the fake reports this token held (the generation is running). */
  async held(): Promise<void> {
    const file = join(mockHoldDir(), `${this.token}.held`);
    await expect
      .poll(() => existsSync(file), {
        message: 'the mock exam generation reaches the hold barrier',
        timeout: MOCK_TIMEOUT_MS,
      })
      .toBe(true);
  }

  /** Lets the held generation (and any later one of the same token) answer. */
  release(): void {
    mkdirSync(mockHoldDir(), { recursive: true });
    writeFileSync(join(mockHoldDir(), `${this.token}.release`), '');
  }
}

/** K8: API + worker + web with WORKER_MOCK_EXAMS=false (MOCK-01-AC08). */
export function startMockExamsOffStack(): Promise<SummaryOffStack> {
  return startSummaryOffStack({ WORKER_MOCK_EXAMS: 'false' });
}

// ---------------------------------------------------------------------------------------------
// API (K1–K3, K5)
// ---------------------------------------------------------------------------------------------

export interface QuestionRange {
  readonly all: boolean;
  /** Outline chapter ids; `'none'` = the "챕터 없음" group (QVIEW-01-C01). */
  readonly chapter_ids: readonly string[];
  readonly question_ids: readonly string[];
  readonly excluded_question_ids: readonly string[];
  readonly filters: {
    readonly status?: readonly DotStatus[];
    readonly favorite?: boolean;
    readonly retry?: boolean;
    readonly type?: QuestionType;
  };
}

export const ALL: QuestionRange = {
  all: true,
  chapter_ids: [],
  question_ids: [],
  excluded_question_ids: [],
  filters: {},
};

export function chaptersRange(...chapterIds: string[]): QuestionRange {
  return { ...ALL, all: false, chapter_ids: chapterIds };
}

export function questionsRange(...questionIds: string[]): QuestionRange {
  return { ...ALL, all: false, question_ids: questionIds };
}

export interface MockConfig {
  readonly variation_types: readonly VariationType[];
  readonly question_count: number | null;
  readonly difficulty?: 'easy' | 'medium' | 'hard' | null;
}

export interface Generation {
  readonly id: string;
  readonly version: number;
  readonly status: GenerationStatus;
  readonly job_id: string;
  readonly requested_count: number;
  readonly created_count: number;
  readonly skipped_count: number;
  readonly error_code: string | null;
  readonly progress: { readonly done: number; readonly total: number } | null;
}

export interface MockExam {
  readonly id: string;
  readonly workspace_id: string;
  readonly title: string;
  readonly version: number;
  readonly status: MockStatus;
  readonly config: MockConfig;
  readonly range: QuestionRange;
  readonly question_count_current: number;
  readonly current_generation: Generation | null;
  readonly latest_generation: Generation | null;
}

export interface MockQuestion {
  readonly id: string;
  readonly position: number;
  readonly question_type: QuestionType;
  readonly variation_type: VariationType;
  readonly stem: string;
  readonly options: readonly QuestionOption[];
  readonly is_multi_answer: boolean;
  readonly revision: { readonly id: string; readonly version: number };
  readonly edited: boolean;
  readonly source: { readonly question_id: string | null; readonly label: string };
  readonly correct_option_ids?: readonly string[] | null;
  readonly explanation?: string | null;
}

export interface MockPracticeSession {
  readonly id: string;
  readonly mock_exam_question_id: string;
  readonly revision_id: string;
  readonly options: readonly QuestionOption[];
}

export interface JobResult {
  readonly status: string;
  readonly result?: {
    readonly created_count?: number;
    readonly skipped_count?: number;
    readonly usage?: { readonly llm_calls?: number; readonly batches?: number };
    readonly error_code?: string | null;
  } | null;
}

export function createMockExamRequest(
  member: Member,
  workspaceId: string,
  body: { title: string; config: MockConfig; range: QuestionRange; seed?: number },
  idempotencyKey?: string,
): Promise<ApiResponse<MockExam>> {
  return member.api.request<MockExam>(
    'POST',
    `/workspaces/${workspaceId}/mock-exams`,
    body,
    idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
  );
}

export async function createMockExam(
  member: Member,
  workspaceId: string,
  title: string,
  config: MockConfig,
  range: QuestionRange = ALL,
): Promise<MockExam> {
  return member.api.ok<MockExam>(
    'POST',
    `/workspaces/${workspaceId}/mock-exams`,
    { title, config, range },
    [202],
  );
}

export async function listMockExams(
  member: Member,
  workspaceId: string,
): Promise<{ llm_available: boolean; items: MockExam[] }> {
  return member.api.ok('GET', `/workspaces/${workspaceId}/mock-exams`, undefined, [200]);
}

export async function getMockExam(member: Member, id: string): Promise<MockExam> {
  return member.api.ok<MockExam>('GET', `/mock-exams/${id}`, undefined, [200]);
}

export async function regenerate(
  member: Member,
  id: string,
  body: { config?: MockConfig; range?: QuestionRange } = {},
): Promise<MockExam> {
  return member.api.ok<MockExam>('POST', `/mock-exams/${id}/generations`, body, [202]);
}

export async function listMockQuestions(
  member: Member,
  id: string,
  withAnswers = false,
): Promise<MockQuestion[]> {
  const query = withAnswers ? '?include=answers' : '';
  const body = await member.api.ok<{ items: MockQuestion[] }>(
    'GET',
    `/mock-exams/${id}/questions${query}`,
    undefined,
    [200],
  );
  return [...body.items].sort((a, b) => a.position - b.position);
}

/** Polls (no sleeps) until the newest generation of `id` is terminal; returns the mock exam. */
export async function waitForMockExam(member: Member, id: string): Promise<MockExam> {
  let exam: MockExam | undefined;
  await expect
    .poll(
      async () => {
        exam = await getMockExam(member, id);
        const status = exam.latest_generation?.status;
        return status !== undefined && !['queued', 'running'].includes(status);
      },
      { message: 'the mock exam generation finishes', timeout: MOCK_TIMEOUT_MS },
    )
    .toBe(true);
  if (!exam) throw new Error('no mock exam');
  return exam;
}

/** K5: LLM calls the fake answered for the generation's job. */
export async function llmCalls(member: Member, generation: Generation): Promise<number> {
  const job = await member.api.ok<JobResult>('GET', `/jobs/${generation.job_id}`, undefined, [200]);
  return job.result?.usage?.llm_calls ?? -1;
}

/** Opens a mock exam question and answers it with its correct option ids (MOCK-P). */
export async function practiseMockQuestion(
  member: Member,
  questionId: string,
  correctOptionIds: readonly string[],
): Promise<{ attempt_id: string; result: string }> {
  const session = await member.api.ok<MockPracticeSession>(
    'POST',
    `/mock-exam-questions/${questionId}/practice-sessions`,
    {},
    [201],
  );
  return member.api.ok(
    'POST',
    `/mock-practice-sessions/${session.id}/submit`,
    { selected_option_ids: correctOptionIds },
    [200],
  );
}

// ---------------------------------------------------------------------------------------------
// UI (MOCK-01)
// ---------------------------------------------------------------------------------------------

export function mockExamsPath(workspaceId: string, mock?: string): string {
  const base = `/workspaces/${workspaceId}?panel=mock-exams`;
  return mock ? `${base}&mock=${mock}` : base;
}

const VARIATION_NAME: Readonly<Record<VariationType, RegExp>> = {
  OPTION_SHUFFLE: /^(보기 섞기|shuffle options)/i,
  PARAPHRASE: /^(문구 변형|paraphrase)/i,
  INVERT_POLARITY: /^(정오 반전|invert polarity)/i,
  ANALOGOUS_CONCEPT: /^(유사 개념|analogous concept)/i,
};

export const VARIATION_LABEL: Readonly<Record<VariationType, RegExp>> = {
  OPTION_SHUFFLE: /보기 섞기|shuffle/i,
  PARAPHRASE: /문구 변형|paraphrase/i,
  INVERT_POLARITY: /정오 반전|invert/i,
  ANALOGOUS_CONCEPT: /유사 개념|analogous/i,
};

export const STATUS_TEXT: Readonly<Record<MockStatus, RegExp>> = {
  generating: /만드는 중|generating/i,
  ready: /준비됨|ready/i,
  partial: /일부만 만듦|partially (made|generated)/i,
  failed: /^(실패|failed)$/i,
};

export const MOCK_TEXT = {
  empty: /아직 모의고사가 없습니다|no mock exams yet/i,
  emptyHint: /`?추가`?로 변형 유형과 범위를 골라|add one to choose variation types and a range/i,
  notFound: /모의고사를 찾을 수 없습니다|mock exam not found/i,
  failed: /모의고사를 만들지 못했습니다|could not make the mock exam/i,
  llmUnavailable: /AI 서비스에 연결하지 못했습니다|could not reach the AI service/i,
  noValid: /검증을 통과한 문제를 만들지 못했습니다|no questions passed validation/i,
  aiDisabled: /이 환경에서는 AI 변형을 쓸 수 없습니다|AI variations are not available here/i,
  aiNotice: /AI 서비스로 전송됩니다|sent to an AI service/i,
  noRange: /출제 범위를 고르세요|choose a range/i,
  working: /문제를 만드는 중입니다|making questions/i,
  replaceConfirm:
    /지금 문제 (\d+)개를 새로 만든 문제로 바꿉니다\. 편집한 문제도 바뀝니다|replaces the current/i,
  edited: /^(편집됨|edited)$/i,
  needsReview: /^(확인 필요|needs review)$/i,
} as const;

/** "선택 n문제 중 m문항을 만듭니다" (the picker's own "선택 n문제": rangePickerUi.selected). */
export function makeText(selected: number, made: number): RegExp {
  return new RegExp(`선택 ${selected}문제 중 ${made}문항을 만듭니다|${made} of ${selected}`, 'i');
}

/** "n개 중 k개" (any k when omitted) — the generation progress value text. */
export function progressText(total: number, done?: number): RegExp {
  const k = done === undefined ? '\\d+' : String(done);
  return new RegExp(`${total}개 중 ${k}개|${k} of ${total}`, 'i');
}

/** "n문항 중 k문항을 만들었습니다. j개는 검증을 통과하지 못했습니다." */
export function partialText(requested: number, created: number): RegExp {
  const skipped = requested - created;
  return new RegExp(
    `${requested}문항 중 ${created}문항을 만들었습니다\\. ${skipped}개는 검증을 통과하지 못했습니다|${created} of ${requested}`,
    'i',
  );
}

export const mockUi = {
  menuItem: (page: Page) =>
    page
      .getByRole('menu', { name: /^(문제 메뉴|question menu)$/i })
      .getByRole('menuitem', { name: /^(모의고사|mock exams?)$/i }),
  generateMenuItem: (page: Page) =>
    page
      .getByRole('menu', { name: /^(문제 메뉴|question menu)$/i })
      .getByRole('menuitem', { name: /^(변형 출제|generate variants?)$/i }),
  dialog: (page: Page) =>
    main(page).getByRole('dialog', { name: /^(모의고사|문제 풀기|mock exams?|practice)$/i }),
  close: (dialog: Locator) =>
    dialog.getByRole('button', { name: /^(모의고사 닫기|close mock exams?|닫기|close)$/i }),
  busy: (dialog: Locator) => dialog.locator('[aria-busy="true"]'),
  loading: (dialog: Locator) =>
    dialog.getByRole('status').filter({ hasText: /불러오는 중|loading/i }),
  count: (dialog: Locator, n: number) =>
    dialog.getByText(new RegExp(`^(모의고사 ${n}개|${n} mock exams?)$`, 'i')),
  add: (dialog: Locator) => dialog.getByRole('button', { name: /^(추가|add)$/i }),
  list: (dialog: Locator) =>
    dialog.getByRole('list', { name: /^(모의고사 목록|mock exam list|mock exams)$/i }),
  rows: (dialog: Locator) => mockUi.list(dialog).getByRole('listitem'),
  row: (dialog: Locator, title: string) =>
    mockUi
      .rows(dialog)
      .filter({ has: dialog.page().getByRole('button', { name: title, exact: true }) }),
  open: (row: Locator, title: string) => row.getByRole('button', { name: title, exact: true }),
  practise: (scope: Locator) => scope.getByRole('button', { name: /^(풀기|practi[cs]e|start)$/i }),
  rowMenu: (row: Locator, title: string) =>
    row.getByRole('button', { name: new RegExp(`^${escape(title)} (메뉴|menu)$`, 'i') }),
  menuAction: (page: Page, name: RegExp) => page.getByRole('menu').getByRole('menuitem', { name }),
  renameField: (scope: Locator) =>
    scope.getByRole('textbox', { name: /^(모의고사 이름|이름|mock exam name|name)$/i }),
  backToList: (dialog: Locator) =>
    dialog
      .getByRole('link', { name: /모의고사 목록|mock exam list/i })
      .or(dialog.getByRole('button', { name: /모의고사 목록|mock exam list/i })),
  heading: (dialog: Locator, name: RegExp | string) => dialog.getByRole('heading', { name }),
  // Create / 설정 바꾸기 (two steps)
  steps: (dialog: Locator) =>
    dialog.getByRole('list', { name: /^(진행 단계|풀기 단계|progress steps)$/i }),
  title: (dialog: Locator) => dialog.getByRole('textbox', { name: /^(이름|name)$/i }),
  variationGroup: (dialog: Locator) =>
    dialog.getByRole('group', { name: /^(변형 유형|variation types?)$/i }),
  variation: (dialog: Locator, type: VariationType) =>
    mockUi.variationGroup(dialog).getByRole('checkbox', { name: VARIATION_NAME[type] }),
  variations: (dialog: Locator) => mockUi.variationGroup(dialog).getByRole('checkbox'),
  questionCount: (dialog: Locator) =>
    dialog
      .getByRole('spinbutton', { name: /^(문항 수|number of questions)/i })
      .or(dialog.getByRole('textbox', { name: /^(문항 수|number of questions)/i })),
  difficulty: (dialog: Locator) => dialog.getByRole('combobox', { name: /^(난이도|difficulty)/i }),
  next: (dialog: Locator) => dialog.getByRole('button', { name: /^(다음|next)$/i }),
  previous: (dialog: Locator) => dialog.getByRole('button', { name: /^(이전|back|previous)$/i }),
  make: (dialog: Locator) => dialog.getByRole('button', { name: /^(만들기|create)$/i }),
  remake: (scope: Locator) => scope.getByRole('button', { name: /^(다시 만들기|regenerate)$/i }),
  retry: (scope: Locator) => scope.getByRole('button', { name: /^(다시 시도|try again)$/i }),
  // QuestionRangePicker: fixtures/range-picker.ts rangePickerUi (shared with QVIEW-01)
  // Detail
  questions: (dialog: Locator) =>
    dialog.getByRole('list', { name: /^(문제 목록|questions)$/i }).getByRole('listitem'),
  progress: (scope: Locator) =>
    scope.getByRole('progressbar', { name: /문제 생성 진행률|generation progress/i }),
  alert: (dialog: Locator) => dialog.getByRole('alert').filter({ hasText: MOCK_TEXT.failed }),
  edit: (scope: Locator) => scope.getByRole('button', { name: /^(편집|edit)$/i }),
  remove: (scope: Locator) =>
    scope.getByRole('button', { name: /이 모의고사에서 빼기|remove from (this )?mock exam/i }),
  changeSettings: (scope: Locator) =>
    scope.getByRole('button', { name: /^(설정 바꾸기|change settings)$/i }),
  rename: (scope: Locator) => scope.getByRole('button', { name: /^(이름 바꾸기|rename)$/i }),
  delete: (scope: Locator) => scope.getByRole('button', { name: /^(삭제|delete)$/i }),
  confirm: (page: Page) => page.getByRole('alertdialog'),
  confirmButton: (confirm: Locator) =>
    confirm.getByRole('button', {
      name: /^(삭제|빼기|다시 만들기|바꾸기|확인|delete|remove|regenerate|confirm)$/i,
    }),
  /** QuestionViewer `manage` of a mock exam question (modal). */
  viewer: (page: Page, k: number) =>
    page.getByRole('dialog', { name: new RegExp(`^(문제 ${k}|question ${k})(?!\\d)`, 'i') }),
  /**
   * QuestionViewer `sequence(mock)` (QVIEW-01): the modal run panel. Only its range step is
   * titled "<이름> 풀기" (practiceTitle); a position's title names the question ("문제 k").
   */
  // Portalled to <body>; since UX9 the home dialogs (portalled into <main>) are modal too.
  practicePanel: (page: Page) =>
    page.getByRole('dialog').and(page.locator('body > [role="dialog"][aria-modal="true"]')),
  practiceTitle: (panel: Locator, title: string) =>
    panel.getByRole('heading', { name: new RegExp(`${escape(title)} (풀기|practi[cs]e)`, 'i') }),
};

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Opens the header `문제` menu and chooses `모의고사`; returns the dialog. */
export async function openMockExams(page: Page): Promise<Locator> {
  const url = new URL(page.url());
  url.searchParams.append('panel', 'mock-exams');
  await page.goto(url.toString());
  const dialog = mockUi.dialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/** "문제 k · <발문 앞부분>" rows of the detail view, as text. */
export async function questionRowTexts(dialog: Locator): Promise<string[]> {
  return mockUi.questions(dialog).allInnerTexts();
}

/** A question row of the detail view by its position k. */
export function questionRow(dialog: Locator, k: number): Locator {
  return mockUi
    .questions(dialog)
    .filter({ hasText: new RegExp(`^\\s*(문제 ${k}|question ${k})(?!\\d)`, 'i') });
}
