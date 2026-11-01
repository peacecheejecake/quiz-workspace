// QVIEW-01 range practice (`QuestionViewer` sequence mode, docs/screens/question-viewer.md;
// docs/questions.md §12) fixtures: practice run API helpers, the seeded range workspace, a minimal
// mock exam seed for QVIEW-01-AC05 and the UI label contract. QVIEW.0 keeps every assumption about
// QVIEW-B / QVIEW-W / MOCK-P / MOCK-W in this header; a deliberate change is a one-place edit here
// (and in tests/integration/questions/practice_runs/test_practice_runs_contract.py, which mirrors
// the API half). Import it directly (not re-exported from fixtures/test.ts).
//
// Grounded in the docs: routes (docs/architecture.md §6: POST /workspaces/{id}/practice-runs,
// GET /practice-runs/{id} · /items/{position} · /results?offset&limit (limit ≤ 200),
// POST /practice-runs/{id}/finish), the `practice_runs` row (architecture §5: source bank|mock,
// range jsonb, random_order, seed, item_ids uuid[] ≤ 5,000, finished_at; practice_sessions gain
// practice_run_id + run_position), the range shape and problems of QVIEW-01-C01 (422
// range-invalid, 409 no-matching-questions, 422 practice-run-too-large, 409 already-submitted,
// 403 workspace-archived, 404 for another user's run) and `random.Random(seed).shuffle` (C02).
//
// NOT in the docs (QVIEW.0 assumptions, to confirm or change in QVIEW-B / MOCK-P):
//   P1 POST /workspaces/{id}/practice-runs (optional `Idempotency-Key`) body
//        {source: "bank", range: RunRange, random_order: boolean, seed?: integer}
//      | {source: "mock", mock_exam_id, range: RunRange, random_order, seed?}
//      RunRange = {all?: boolean, chapter_ids?: string[], question_ids?: string[],
//                  excluded_question_ids?: string[], filters?: {status?: DotStatus[],
//                  favorite?: boolean, retry?: boolean, type?: QuestionType}}
//      (`all` / `chapter_ids` select whole groups; `question_ids` adds single questions;
//      `excluded_question_ids` removes questions from those groups; filters narrow the result the
//      way the overview's `status` / `favorite` / `retry` / `type` query does) → 201 PracticeRun.
//   P2 PracticeRun = {id, workspace_id, source, mock_exam_id: string|null, random_order, seed:
//      integer, total, finished_at: string|null, summary: {correct, incorrect, pending, skipped}}
//      — no item list, no question content (C02). `skipped` counts positions without a submitted
//      attempt (skipped or unavailable) once the run is finished, and the positions before the
//      furthest one reached while it is open.
//   P3 GET /practice-runs/{id}/items/{position} (1-based) → 200 RunItem =
//        {position, total, available: boolean, question_id: string|null, chapter_number,
//         question_number, question_type, stem, is_multi_answer, options: [{id, text}],
//         attempt: null | {attempt_id, result, submitted_answer, correct_option_ids,
//                          accepted_answers, explanation, rubric}}
//      `available: false` (question deleted/archived since the run started, or removed from the
//      mock exam) carries no content. Answer fields appear only inside `attempt`, which exists only
//      after that position was submitted. position outside 1..total → 404.
//   P4 A position is practised through the existing practice API with the run link:
//        POST /questions/{qid}/practice-sessions {practice_run_id, run_position} → 201
//        PracticeSession (bank; records the view like the panel) and
//        POST /mock-exam-questions/{id}/practice-sessions {practice_run_id, run_position} (mock);
//      submit / self-grade are the existing /practice-sessions/{id}/submit · /self-grade (bank)
//      and /mock-practice-sessions/{id}/submit · /self-grade (mock). A position that already has a
//      submitted attempt refuses a new session or a second submit with 409 already-submitted.
//   P5 GET /practice-runs/{id}/results?offset=&limit= → 200 {total, items: [{position,
//      question_id|null, label, preview, result: correct|incorrect|pending|skipped|null}]}.
//   P6 APP_ENV=test fixes the server-chosen seed to PRACTICE_RUN_TEST_SEED when the request sends
//      none (AC03 "fake seed 고정"), so a random run of five shows Heatmap positions
//      TEST_SEED_ORDER_5 = random.Random(20261101).shuffle([1, 2, 3, 4, 5]).
//   P7 Mock exams (MOCK-01, owned by MOCK.0's tests/e2e/fixtures/mock-exams.ts; only what AC05
//      needs is repeated here): POST /workspaces/{id}/mock-exams {name, config:
//      {variation_types: ["OPTION_SHUFFLE"], question_count}, range: RunRange} → 201/202
//      MockExam {id, status, ...}; GET /mock-exams/{id} until status `ready`; GET
//      /mock-exams/{id}/questions → {items: [{id, ...}]}. `보기 섞기` needs no LLM.
//
// UI contract (Korean first, English accepted; AGENTS.md §5):
//   `문제` menu item "문제 풀기" (every member, archived workspaces too) opens a modal
//   FloatingSidePanel (aria-modal="true") named "문제 풀기" (mock: "<모의고사 이름> 풀기") at
//   `?practice=new&source=bank`, busy skeleton "불러오는 중" first. Range step: checkbox "전체 선택"
//   (aria-checked="mixed" when partly selected), one checkbox per chapter named by the chapter
//   title (+ count) with its own expand button "<장 제목> 펼치기" (aria-expanded), question
//   checkboxes "1장 1번 · <발문 앞부분> · <유형>", the text "선택 n문제", a collapsible "상태 필터"
//   group with the home chips (틀린 문제/오답, 다시 풀기, …) and "필터 초기화", checkbox
//   "무작위 순서" (off), button "시작" (disabled + "풀 문제를 고르세요" with nothing selected).
//   Solving step: heading "1장 1번" (mock "문제 k", focused on each change), progressbar with
//   aria-valuetext "n문제 중 k번째" and the same text in an aria-live="polite" region, the
//   QPLAY-01 body (radios/checkboxes named by the option text, textbox "답안", button "제출",
//   role=status result 정답/오답/채점 대기, self-grade 맞음/틀림), footer "이전", "다음" (after a
//   result; "결과 보기" on the last position), "건너뛰기". URL `?practice=<id>&i=<k>`.
//   Results step: text "맞음 x · 틀림 y · 채점 대기 z · 건너뜀 w", list "문제별 결과" of buttons
//   ("<번호> · <발문> · <결과 글자>"), buttons "처음부터 다시", "닫기".
//   Notices: "이 문제는 더 이상 풀 수 없습니다.", "조건에 맞는 문제가 없습니다.", "풀이를 찾을 수
//   없습니다.", "보관된 Workspace에서는 답안을 제출할 수 없습니다.".
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { apiError, type ApiResponse } from './api.ts';
import { JOB_TIMEOUT_MS, outlineNodeId, uploadReadyBook } from './documents.ts';
import { seedMembership } from './db.ts';
import { localDbAdminUrl } from './local-env.ts';
import {
  archiveQuestion,
  createQuestion,
  mcqInput,
  startPractice,
  submitPractice,
  type DotStatus,
  type Question,
  type QuestionInput,
  type QuestionType,
} from './questions.ts';
import { homeUi } from './workspace-ui.ts';
import type { Member, WorkspaceFactory } from './workspaces.ts';

export const CH1 = '1장 물의 순환';
export const CH2 = '2장 정수 처리';
export const PRACTICE_RUN_MAX = 5_000;
/** P6: the APP_ENV=test server seed and the Heatmap positions it gives a five-question run. */
export const PRACTICE_RUN_TEST_SEED = 20261101;
export const TEST_SEED_ORDER_5: readonly number[] = [3, 4, 2, 5, 1];

export const RUN_PROBLEMS = {
  rangeInvalid: 'urn:quiz-workspace:problem:range-invalid',
  noMatching: 'urn:quiz-workspace:problem:no-matching-questions',
  tooLarge: 'urn:quiz-workspace:problem:practice-run-too-large',
  alreadySubmitted: 'urn:quiz-workspace:problem:already-submitted',
} as const;

// ---------------------------------------------------------------------------------------------
// API (P1–P5)
// ---------------------------------------------------------------------------------------------

export interface RunRange {
  readonly all?: boolean;
  readonly chapter_ids?: readonly string[];
  readonly question_ids?: readonly string[];
  readonly excluded_question_ids?: readonly string[];
  readonly filters?: {
    readonly status?: readonly DotStatus[];
    readonly favorite?: boolean;
    readonly retry?: boolean;
    readonly type?: QuestionType;
  };
}

export interface RunRequest {
  readonly source: 'bank' | 'mock';
  readonly mock_exam_id?: string;
  readonly range: RunRange;
  readonly random_order: boolean;
  readonly seed?: number;
}

export interface RunSummary {
  readonly correct: number;
  readonly incorrect: number;
  readonly pending: number;
  readonly skipped: number;
}

export interface PracticeRun {
  readonly id: string;
  readonly workspace_id: string;
  readonly source: 'bank' | 'mock';
  readonly mock_exam_id: string | null;
  readonly random_order: boolean;
  readonly seed: number;
  readonly total: number;
  readonly finished_at: string | null;
  readonly summary: RunSummary;
}

export interface RunItem {
  readonly position: number;
  readonly total: number;
  readonly available: boolean;
  readonly question_id: string | null;
  readonly stem?: string;
  readonly options?: readonly { readonly id: string; readonly text: string }[];
  readonly attempt: null | {
    readonly attempt_id: string;
    readonly result: 'correct' | 'incorrect' | 'pending';
  };
}

export interface RunResults {
  readonly total: number;
  readonly items: readonly {
    readonly position: number;
    readonly question_id: string | null;
    readonly result: 'correct' | 'incorrect' | 'pending' | 'skipped' | null;
  }[];
}

/** Raw P1 call (any status): problem tests assert the refusal themselves. */
export function requestPracticeRun(
  member: Member,
  workspaceId: string,
  body: RunRequest,
  headers: Record<string, string> = {},
): Promise<ApiResponse<PracticeRun>> {
  return member.api.request<PracticeRun>(
    'POST',
    `/workspaces/${workspaceId}/practice-runs`,
    body,
    headers,
  );
}

export async function createPracticeRun(
  member: Member,
  workspaceId: string,
  body: RunRequest,
): Promise<PracticeRun> {
  const path = `/workspaces/${workspaceId}/practice-runs`;
  const res = await requestPracticeRun(member, workspaceId, body);
  if (res.status !== 201 || !res.body) throw apiError('POST', path, res);
  return res.body;
}

export function getPracticeRun(member: Member, runId: string): Promise<ApiResponse<PracticeRun>> {
  return member.api.request<PracticeRun>('GET', `/practice-runs/${runId}`);
}

export async function runItem(member: Member, runId: string, position: number): Promise<RunItem> {
  return member.api.ok<RunItem>(
    'GET',
    `/practice-runs/${runId}/items/${position}`,
    undefined,
    [200],
  );
}

/** Question ids of the run in run order (one item read per position, P3). */
export async function runOrder(member: Member, runId: string, total: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 1; i <= total; i += 1) out.push((await runItem(member, runId, i)).question_id ?? '');
  return out;
}

export async function runResults(member: Member, runId: string): Promise<RunResults> {
  return member.api.ok<RunResults>(
    'GET',
    `/practice-runs/${runId}/results?offset=0&limit=200`,
    undefined,
    [200],
  );
}

/** P4: a practice session of one run position (bank). */
export function openRunSession(
  member: Member,
  questionId: string,
  runId: string,
  position: number,
): Promise<ApiResponse<{ id: string }>> {
  return member.api.request<{ id: string }>('POST', `/questions/${questionId}/practice-sessions`, {
    practice_run_id: runId,
    run_position: position,
  });
}

// ---------------------------------------------------------------------------------------------
// Mock exam seed for QVIEW-01-AC05 (P7)
// ---------------------------------------------------------------------------------------------

export interface MockExam {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

/** A `보기 섞기` mock exam of `count` questions from `questionIds`, waited until `ready`. */
export async function createShuffleMockExam(
  owner: Member,
  workspaceId: string,
  name: string,
  questionIds: readonly string[],
  count: number,
): Promise<MockExam> {
  const created = await owner.api.ok<MockExam>(
    'POST',
    `/workspaces/${workspaceId}/mock-exams`,
    {
      name,
      config: { variation_types: ['OPTION_SHUFFLE'], question_count: count },
      range: { question_ids: questionIds },
    },
    [201, 202],
  );
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  for (;;) {
    const exam = await owner.api.ok<MockExam>('GET', `/mock-exams/${created.id}`, undefined, [200]);
    if (exam.status === 'ready') return exam;
    if (exam.status === 'failed' || Date.now() > deadline) {
      throw new Error(`mock exam ended as ${exam.status}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------------------------------------------------------------------------------------------
// DB reads (fixtures/db.ts rules): rows no API exposes, for "nothing was created/changed" checks
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function psqlCount(sql: string): number {
  try {
    return Number(
      execFileSync('psql', [localDbAdminUrl(), '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      }).trim(),
    );
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim().split('\n')[0] ?? '';
    throw new Error(`practice-runs fixture: psql failed${stderr ? `: ${stderr}` : ''}`, {
      cause: error,
    });
  }
}

function id(value: string): string {
  if (!UUID.test(value)) throw new Error('practice-runs fixture: invalid uuid');
  return `'${value}'`;
}

/** Practice runs of `userId` (QVIEW-01-AC08: a refused start creates none). */
export function practiceRunCount(userId: string): number {
  return psqlCount(`select count(*) from public.practice_runs where user_id = ${id(userId)}`);
}

/** `question_attempts` rows of a workspace (QVIEW-01-AC05: a mock run writes none). */
export function questionAttemptCount(workspaceId: string): number {
  return psqlCount(
    `select count(*) from public.question_attempts where workspace_id = ${id(workspaceId)}`,
  );
}

/** `mock_exam_attempts` rows of a mock exam (QVIEW-01-AC05). */
export function mockAttemptCount(mockExamId: string): number {
  return psqlCount(
    `select count(*) from public.mock_exam_attempts a ` +
      `join public.mock_exam_questions q on q.id = a.mock_exam_question_id ` +
      `where q.mock_exam_id = ${id(mockExamId)}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Seeded range workspace (QVIEW.0 DoD): two chapters of confirmed questions plus drafts, an
// archived question and a merged duplicate (C07)
// ---------------------------------------------------------------------------------------------

export interface RangeWorkspace {
  readonly owner: Member;
  /** A viewer member whose study state the seed sets (see `studyState`). */
  readonly viewer: Member;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly ch1: string;
  readonly ch2: string;
  readonly label: string;
  /** The five CONFIRMED questions in Heatmap order: 1장 1·2·3번, 2장 1·2번. */
  readonly confirmed: readonly Question[];
  /** Two DRAFT questions in 1장 (never in a range). */
  readonly drafts: readonly Question[];
  /** An ARCHIVED 1장 question (never in a range). */
  readonly archived: Question;
  /**
   * A copy of 2장 2번 the viewer answered wrong, then merged into 2장 2번 by the owner
   * (UX7-DEDUP): ARCHIVED, and 2장 2번 is `incorrect` for the viewer only through the merge.
   */
  readonly duplicate: Question;
}

/** Stem of a seeded question; its first 40 characters identify it in the range list. */
export function rangeStem(label: string, chapter: number, n: number): string {
  return `${label} ${chapter}장 ${n}번 문제: 알맞은 것을 고르시오.`;
}

function rangeMcq(label: string, chapter: number, n: number, chapterId: string): QuestionInput {
  const texts = ['가', '나', '다', '라'].map((x) => `${label}-${chapter}-${n} 보기 ${x}`);
  return {
    ...mcqInput(rangeStem(label, chapter, n), texts, 0),
    explanation: `${label}-${chapter}-${n} 해설`,
    chapter_id: chapterId,
    question_number: n,
  };
}

/** Answers `question` wrong (option 2 of a seeded MCQ whose answer is option 1). */
async function answerWrong(member: Member, question: Question): Promise<void> {
  const session = await startPractice(member, question.id);
  const wrong = question.revision.options.find(
    (o) => !(question.revision.correct_option_ids ?? []).includes(o.id),
  );
  const graded = await submitPractice(member, session.id, {
    selected_option_ids: [wrong?.id ?? ''],
  });
  if (graded.result !== 'incorrect') throw new Error(`expected incorrect, got ${graded.result}`);
}

/**
 * book-ko uploaded (chapters "1장 물의 순환" / "2장 정수 처리"), 1장 3 + 2장 2 CONFIRMED MCQs, two
 * DRAFTs, one ARCHIVED question and one merged duplicate. With `studyState` the viewer has
 * answered 1장 2번 wrong directly and 2장 2번 only through the merged duplicate, so the viewer's
 * `틀린 문제` filter keeps exactly 1장 2번 and 2장 2번.
 */
export async function seedRangeWorkspace(
  workspaceFactory: WorkspaceFactory,
  label: string,
  { studyState = true }: { studyState?: boolean } = {},
): Promise<RangeWorkspace> {
  const owner = await workspaceFactory.member(`${label}-owner`);
  const viewer = await workspaceFactory.member(`${label}-viewer`);
  const ws = await workspaceFactory.create(owner);
  seedMembership(ws.id, viewer.user.id, 'viewer');
  const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
  const ch1 = await outlineNodeId(owner, documentId, CH1);
  const ch2 = await outlineNodeId(owner, documentId, CH2);
  const tag = `${label}-${randomUUID().slice(0, 6)}`;
  const confirmed: Question[] = [];
  for (const [chapter, chapterId, count] of [
    [1, ch1, 3],
    [2, ch2, 2],
  ] as const) {
    for (let n = 1; n <= count; n += 1) {
      confirmed.push(await createQuestion(owner, ws.id, rangeMcq(tag, chapter, n, chapterId)));
    }
  }
  const drafts: Question[] = [];
  for (const n of [5, 6]) {
    drafts.push(
      await createQuestion(owner, ws.id, {
        ...rangeMcq(tag, 1, n, ch1),
        publication_status: 'DRAFT',
      }),
    );
  }
  const archived = await archiveQuestion(
    owner,
    await createQuestion(owner, ws.id, rangeMcq(tag, 1, 4, ch1)),
  );
  const keep = confirmed[4];
  if (!keep) throw new Error('seed: 2장 2번 missing');
  const copy = await createQuestion(owner, ws.id, {
    ...rangeMcq(tag, 2, 2, ch2),
    question_number: 3,
  });
  if (studyState) {
    const ch1q2 = confirmed[1];
    if (!ch1q2) throw new Error('seed: 1장 2번 missing');
    await answerWrong(viewer, ch1q2);
    await answerWrong(viewer, copy);
  }
  await owner.api.ok(
    'POST',
    `/workspaces/${ws.id}/question-duplicates/merge`,
    { groups: [{ keep_question_id: keep.id, duplicate_question_ids: [copy.id] }] },
    [200],
  );
  const duplicate = await owner.api.ok<Question>('GET', `/questions/${copy.id}`, undefined, [200]);
  expect(duplicate.publication_status).toBe('ARCHIVED');
  return {
    owner,
    viewer,
    workspaceId: ws.id,
    documentId,
    ch1,
    ch2,
    label: tag,
    confirmed,
    drafts,
    archived,
    duplicate,
  };
}

// ---------------------------------------------------------------------------------------------
// UI contract
// ---------------------------------------------------------------------------------------------

/** `?practice=<id>` of the current URL (null on the range step or when closed). */
export function practiceParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get('practice');
}

export function practiceRunPath(workspaceId: string, runId: string, position?: number): string {
  const i = position === undefined ? '' : `&i=${position}`;
  return `/workspaces/${workspaceId}?practice=${runId}${i}`;
}

/** "1장 1번" (not preceded/followed by another digit). */
export function runLabel(chapter: number, n: number): RegExp {
  return new RegExp(
    `(?<!\\d)${chapter}장 ${n}번(?!\\d)|chapter ${chapter},? (no\\.|question) ${n}(?!\\d)`,
    'i',
  );
}

/** "n문제 중 k번째" as the progress value text. */
export function progressText(k: number, n: number): RegExp {
  return new RegExp(`${n}문제 중 ${k}번째|(?<!\\d)${k} of ${n}(?!\\d)`, 'i');
}

export const runUi = {
  menuItem: (page: Page) =>
    homeUi
      .questionMenu(page)
      .getByRole('menuitem', { name: /^(문제 풀기|practice questions?|start practice)$/i }),
  /** The modal QuestionViewer panel of a run, whatever its step's title. */
  panel: (page: Page) => page.getByRole('dialog').and(page.locator('[aria-modal="true"]')),
  /** The range step's panel title. */
  pickerTitle: (panel: Locator) =>
    panel.getByRole('heading', { name: /^(문제 풀기|practice questions?)$/i }),
  busy: (panel: Locator) =>
    panel.locator('[aria-busy="true"]').or(panel.getByText(/불러오는 중|loading/i)),
  selectAll: (panel: Locator) => panel.getByRole('checkbox', { name: /^(전체 선택|select all)$/i }),
  chapter: (panel: Locator, title: string) =>
    panel.getByRole('checkbox', { name: new RegExp(`^${title}`) }),
  chapters: (panel: Locator) => panel.getByRole('checkbox', { name: /^\d+장 /i }),
  expand: (panel: Locator, title: string) =>
    panel.getByRole('button', { name: new RegExp(`${title}.*(펼치기|접기|expand|collapse)`, 'i') }),
  question: (panel: Locator, chapter: number, n: number) =>
    panel.getByRole('checkbox', { name: new RegExp(`^${chapter}장 ${n}번 · `) }),
  questions: (panel: Locator) => panel.getByRole('checkbox', { name: /^\d+장 \d+번 · / }),
  selected: (panel: Locator, n: number) =>
    panel.getByText(new RegExp(`선택 ${n}문제|${n} selected`, 'i')),
  filterToggle: (panel: Locator) =>
    panel.getByRole('button', { name: /^(상태 필터|필터|status filter|filters?)$/i }),
  filters: (panel: Locator) =>
    panel.getByRole('group', { name: /^(상태 필터|필터|status filter|filters?)$/i }),
  incorrectFilter: (panel: Locator) =>
    runUi
      .filters(panel)
      .getByRole('button', { name: /^(틀린 문제|오답|incorrect)$/i })
      .or(runUi.filters(panel).getByRole('checkbox', { name: /^(틀린 문제|오답|incorrect)$/i })),
  retryFilter: (panel: Locator) =>
    runUi
      .filters(panel)
      .getByRole('button', { name: /^(다시 풀기만?|retry( only)?)$/i })
      .or(runUi.filters(panel).getByRole('checkbox', { name: /^(다시 풀기만?|retry( only)?)$/i })),
  resetFilters: (panel: Locator) =>
    panel.getByRole('button', { name: /^(필터 초기화|reset filters?|clear filters?)$/i }),
  random: (panel: Locator) =>
    panel.getByRole('checkbox', { name: /^(무작위 순서|random order|shuffle)$/i }),
  start: (panel: Locator) => panel.getByRole('button', { name: /^(시작|start)$/i }),
  startReason: (panel: Locator) =>
    panel.getByText(/풀 문제를 고르세요|choose questions to practi[sc]e/i),
  noMatch: (panel: Locator) => panel.getByText(/조건에 맞는 문제가 없습니다|no questions match/i),
  // Solving step
  title: (panel: Locator, chapter: number, n: number) =>
    panel.getByRole('heading', { name: runLabel(chapter, n) }),
  mockTitle: (panel: Locator, k: number) =>
    panel.getByRole('heading', { name: new RegExp(`^(문제|question) ${k}$`, 'i') }),
  progress: (panel: Locator) => panel.getByRole('progressbar'),
  live: (panel: Locator) => panel.locator('[aria-live="polite"]'),
  option: (panel: Locator, text: string) =>
    panel
      .getByRole('radio', { name: text, exact: true })
      .or(panel.getByRole('checkbox', { name: text, exact: true })),
  answerText: (panel: Locator) => panel.getByRole('textbox', { name: /답안|answer/i }),
  submit: (panel: Locator) => panel.getByRole('button', { name: /^(답안 )?제출|^submit/i }),
  result: (panel: Locator) =>
    panel.getByRole('status').filter({ hasText: /정답|오답|채점 대기|correct|pending/i }),
  selfGradeCorrect: (panel: Locator) =>
    panel.getByRole('button', { name: /^(맞음|맞았|정답으로|correct)/i }),
  next: (panel: Locator) => panel.getByRole('button', { name: /^(다음|next)$/i }),
  previous: (panel: Locator) => panel.getByRole('button', { name: /^(이전|previous)$/i }),
  skip: (panel: Locator) => panel.getByRole('button', { name: /^(건너뛰기|skip)$/i }),
  showResults: (panel: Locator) =>
    panel.getByRole('button', { name: /^(결과 보기|show results|see results)$/i }),
  close: (panel: Locator) =>
    panel.getByRole('button', { name: /패널 닫기|^닫기$|^close/i }).first(),
  favorite: (panel: Locator) => panel.getByRole('button', { name: /즐겨찾기|favou?rite/i }),
  retryToggle: (panel: Locator) =>
    panel.getByRole('button', { name: /다시 풀기 (표시|해제)|(mark|clear) (for )?retry/i }),
  unavailable: (panel: Locator) =>
    panel.getByText(/이 문제는 더 이상 풀 수 없습니다|no longer available/i),
  archivedNotice: (panel: Locator) =>
    panel.getByText(/보관된 workspace에서는 답안을 제출할 수 없습니다|archived workspace/i),
  notFound: (panel: Locator) =>
    panel.getByText(/풀이를 찾을 수 없습니다|practice (run )?not found/i),
  // Results step
  summary: (
    panel: Locator,
    s: { correct: number; incorrect: number; pending: number; skipped: number },
  ) =>
    panel.getByText(
      new RegExp(
        `맞음 ${s.correct}\\s*·\\s*틀림 ${s.incorrect}\\s*·\\s*채점 대기 ${s.pending}\\s*·\\s*건너뜀 ${s.skipped}|` +
          `${s.correct} correct.*${s.incorrect} incorrect.*${s.pending} pending.*${s.skipped} skipped`,
        'i',
      ),
    ),
  resultList: (panel: Locator) =>
    panel.getByRole('list', { name: /문제별 결과|results by question|results/i }),
  resultRows: (panel: Locator) => runUi.resultList(panel).getByRole('listitem'),
  restart: (panel: Locator) =>
    panel.getByRole('button', { name: /^(처음부터 다시|start over|restart)$/i }),
};

/**
 * Opens the header's `문제` menu and checks it lists `문제 풀기` (the menu itself must open with
 * its existing items first, so a missing item is told apart from a menu that did not open).
 */
export async function openQuestionMenuWithPractice(page: Page): Promise<void> {
  await homeUi.questionMenuButton(page).click();
  const menu = homeUi.questionMenu(page);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toBeVisible();
  await expect(runUi.menuItem(page), '`문제` menu has a 문제 풀기 item').toBeVisible();
}

/** Opens `문제` › `문제 풀기` and waits for the range step's panel. */
export async function openRangePicker(page: Page): Promise<Locator> {
  await openQuestionMenuWithPractice(page);
  await runUi.menuItem(page).click();
  const panel = runUi.panel(page);
  await expect(panel).toBeVisible();
  await expect(runUi.pickerTitle(panel)).toBeVisible();
  return panel;
}

/**
 * Moves forward to the results step from wherever the run is: `결과 보기` when shown, otherwise
 * `다음` (a position with a result) or `건너뛰기` (an open position).
 */
export async function goToResults(panel: Locator, maxSteps = 10): Promise<void> {
  for (let step = 0; step < maxSteps; step += 1) {
    if (await runUi.showResults(panel).isVisible()) {
      await runUi.showResults(panel).click();
      await expect(runUi.restart(panel)).toBeVisible();
      return;
    }
    const next = runUi.next(panel);
    const target = (await next.isVisible()) ? next : runUi.skip(panel);
    await target.click();
  }
  throw new Error('results step not reached');
}
