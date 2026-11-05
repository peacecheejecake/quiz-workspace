// QVIEW-01 — 통합 문제 보기 `QuestionViewer`: range practice popup (`?practice=new&source=bank`,
// `?practice=<id>&i=<k>`), docs/screens/question-viewer.md; rules docs/questions.md §12, §4,
// docs/e2e-strategy.md §6 (answer leak by network interception, URL state across reload). Contract
// half (QVIEW-01-C01–C05, C07): tests/integration/questions/practice_runs/.
//
// Each test signs in its own members and works in its own workspace. Questions come from the
// public question API; the two-chapter range tests upload book-ko (chapters "1장 물의 순환" /
// "2장 정수 처리") and add 1장 3 + 2장 2 CONFIRMED questions, two drafts, an archived question and
// a duplicate merged into 2장 2번 (fixtures/practice-runs.ts `seedRangeWorkspace`). Every API and
// label assumption (P1–P7, the UI contract) is in the header of fixtures/practice-runs.ts.
// QVIEW-01-AC05 starts from a mock exam (MOCK-01) and turns GREEN with MOCK-W, the others with
// QVIEW-W (implementation-plan §3 MOCK gate); QVIEW.0 stays out of CI `E2E_PHASES` until then.
//
// The panel shows answers and explanations after a submission: traces, screenshots and videos are
// off, and shown answers are checked with role/text assertions on synthetic strings only.
import { randomUUID } from 'node:crypto';
import type { Locator, Page, Request, Response } from '@playwright/test';
import { outlineNodeId, uploadReadyBook } from '../fixtures/documents.ts';
import {
  createPracticeRun,
  createShuffleMockExam,
  getPracticeRun,
  goToResults,
  mockAttemptCount,
  openQuestionMenuWithPractice,
  openRangePicker,
  openRunSession,
  practiceParam,
  practiceRunCount,
  practiceRunPath,
  PRACTICE_RUN_TEST_SEED,
  progressText,
  questionAttemptCount,
  rangeStem,
  requestPracticeRun,
  runOrder,
  runResults,
  runUi,
  RUN_PROBLEMS,
  seedRangeWorkspace,
  TEST_SEED_ORDER_5,
  CH1,
  CH2,
  type RangeWorkspace,
} from '../fixtures/practice-runs.ts';
import {
  createShareLink,
  expect,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  sharedUi,
  test,
} from '../fixtures/sharing.ts';
import {
  answerKeysIn,
  createQuestion,
  getOverview,
  homePath,
  homeUi,
  JOB_TIMEOUT_MS,
  listAttempts,
  mcqInput,
  overviewItem,
  overviewPath,
  overviewUi,
  PROBLEM_TYPES,
  RESULT_TEXT,
  signInAs,
  type Member,
  type Problem,
  type Question,
  type QuestionInput,
} from '../fixtures/test.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({
  storageState: { cookies: [], origins: [] },
  ...NO_VISUAL_ARTIFACTS,
  attachPageTextOnFailure: false,
});
test.describe.configure({ timeout: JOB_TIMEOUT_MS + 120_000 });

function unique(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nth<T>(items: readonly T[], i: number): T {
  const found = items[i];
  if (found === undefined) throw new Error(`no item ${i}`);
  return found;
}

async function openHome(page: Page, member: Member, workspaceId: string): Promise<void> {
  await signInAs(page, member.user);
  await page.goto(overviewPath(workspaceId));
  await expect(homeUi.questionMenuButton(page)).toBeVisible();
}

/** Expands every collapsed chapter group of the range step. */
async function expandAll(panel: Locator): Promise<void> {
  const collapsed = panel.getByRole('button', { name: /펼치기|expand/i, expanded: false });
  for (let i = 0; i < 20 && (await collapsed.count()) > 0; i += 1) {
    await collapsed.first().click();
  }
  await expect(collapsed).toHaveCount(0);
}

/** A mock exam's question checkboxes ("문제 k · …"), not its chapter ones ("1장 … · 2문제"). */
function mockBoxes(panel: Locator): Locator {
  return panel.getByRole('checkbox', { name: /^(문제|question) \d+ · /i });
}

/** Selects every question and starts the run; returns its id from `?practice=`. */
async function startAll(page: Page, panel: Locator, random = false): Promise<string> {
  await runUi.selectAll(panel).check();
  if (random) await runUi.random(panel).check();
  await expect(runUi.start(panel)).toBeEnabled();
  await runUi.start(panel).click();
  await expect(page).toHaveURL(/[?&]practice=[0-9a-f-]{36}(&|$)/);
  await expect(page).toHaveURL(/[?&]i=1(&|$)/);
  return practiceParam(page) ?? '';
}

function correctText(question: Question): string {
  const ids = question.revision.correct_option_ids ?? [];
  return question.revision.options.find((o) => ids.includes(o.id))?.text ?? '';
}

function wrongOption(question: Question): { id: string; text: string } {
  const ids = question.revision.correct_option_ids ?? [];
  const found = question.revision.options.find((o) => !ids.includes(o.id));
  if (!found) throw new Error('no wrong option');
  return found;
}

/** Answers the shown MCQ with `text` and waits for the graded result. */
async function answerMcq(panel: Locator, text: string, result: RegExp): Promise<void> {
  await runUi.option(panel, text).check();
  await runUi.submit(panel).click();
  await expect(runUi.result(panel)).toContainText(result);
}

async function answerEssay(panel: Locator, text: string): Promise<void> {
  await runUi.answerText(panel).fill(text);
  await runUi.submit(panel).click();
  await expect(runUi.result(panel)).toContainText(RESULT_TEXT.pending);
}

interface Captured {
  readonly path: string;
  readonly contentType: string;
  readonly text: string;
}

/** Every document/fetch/xhr response body until `stop()` (as in questions-practice.spec.ts). */
function captureResponses(page: Page): { stop: () => Promise<Captured[]> } {
  const pending: Promise<Captured | undefined>[] = [];
  const onResponse = (res: Response) => {
    const type = res.request().resourceType();
    if (!['document', 'fetch', 'xhr'].includes(type)) return;
    const prefetch = res.request().headers()['next-router-prefetch'] !== undefined;
    if (prefetch && new URL(res.url()).pathname !== new URL(page.url()).pathname) return;
    pending.push(
      res
        .text()
        .then((text) => ({
          path: new URL(res.url()).pathname,
          contentType: res.headers()['content-type'] ?? '',
          text,
        }))
        .catch(() => undefined),
    );
  };
  page.on('response', onResponse);
  return {
    stop: async () => {
      page.off('response', onResponse);
      return (await Promise.all([...pending])).filter((c): c is Captured => c !== undefined);
    },
  };
}

const ANSWER_KEY_IN_TEXT =
  /\\?"(correct_option_ids|accepted_answers|explanation|rubric|correct_answer)\\?"\s*:/;

function leaks(captured: readonly Captured[], secrets: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of captured) {
    if (c.contentType.includes('json')) {
      try {
        out.push(...answerKeysIn(JSON.parse(c.text)).map((k) => `${c.path}: ${k}`));
      } catch {
        out.push(`${c.path}: unparsable JSON`);
      }
    } else if (ANSWER_KEY_IN_TEXT.test(c.text)) {
      out.push(`${c.path}: answer field in ${c.contentType}`);
    }
    for (const secret of secrets) if (c.text.includes(secret)) out.push(`${c.path}: answer text`);
  }
  return out;
}

/** A workspace without a book: `inputs` as questions 1..n (no chapter → one "챕터 없음" group). */
async function seedFlat(
  workspaceFactory: WorkspaceFactory,
  label: string,
  inputs: readonly QuestionInput[],
): Promise<{ owner: Member; workspaceId: string; questions: Question[] }> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const questions: Question[] = [];
  for (const [i, input] of inputs.entries()) {
    questions.push(await createQuestion(owner, ws.id, { question_number: i + 1, ...input }));
  }
  return { owner, workspaceId: ws.id, questions };
}

function flatMcq(label: string, n: number, explanation?: string): QuestionInput {
  const texts = ['가', '나', '다', '라'].map((x) => `${label}-${n} 보기 ${x}`);
  return {
    ...mcqInput(`${label}-${n} 문제: 알맞은 것을 고르시오.`, texts, 1),
    explanation: explanation ?? `${label}-${n} 해설`,
  };
}

function essay(label: string, n: number): QuestionInput {
  return {
    question_type: 'ESSAY',
    stem: `${label}-${n} 서술형: 물의 순환을 설명하시오.`,
    rubric: `${label}-${n} 채점 기준`,
    explanation: `${label}-${n} 서술형 해설`,
  };
}

test(
  'QVIEW-01-AC01 문제 › 문제 풀기 opens the modal range step at once with two chapter groups and no drafts',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s: RangeWorkspace = await seedRangeWorkspace(workspaceFactory, 'qview01-ac01');
    await openHome(page, s.viewer, s.workspaceId);

    // Hold the API reads: the panel must already be open, busy, before any data arrives.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const isApi = (url: URL) => /\/api\/workspaces\/[^/]+\/questions\/overview$/.test(url.pathname);
    // The held reads continue before the route goes: unrouting while a handler still waits lets
    // Playwright drop the interception under it ("Route is already handled").
    const held: Promise<void>[] = [];
    await page.route(
      isApi, // the same function instance unroutes it below
      (route) => {
        const continued = gate.then(() => route.continue());
        held.push(continued);
        return continued;
      },
    );
    await openQuestionMenuWithPractice(page);
    const panel = runUi.panel(page);
    await expect(panel).toBeVisible();
    await expect(runUi.pickerTitle(panel)).toBeVisible();
    await expect(runUi.busy(panel).first()).toBeVisible();
    await expect(page).toHaveURL(/[?&]practice=new(&|$)/);
    await expect(page).toHaveURL(/[?&]source=bank(&|$)/);
    release();
    await Promise.all(held);
    await page.unroute(isApi);

    await expect(runUi.chapters(panel)).toHaveCount(2);
    await expect(runUi.chapter(panel, CH1)).toBeVisible();
    await expect(runUi.chapter(panel, CH2)).toBeVisible();
    await expect(runUi.selectAll(panel)).not.toBeChecked();
    await expect(runUi.random(panel)).not.toBeChecked();
    await expect(runUi.start(panel)).toBeDisabled();
    await expect(runUi.startReason(panel)).toBeVisible();

    // Groups start collapsed; expanded, they list "1장 1번 · <발문 앞부분>" — confirmed only.
    await expect(runUi.expand(panel, CH1)).toHaveAttribute('aria-expanded', 'false');
    await runUi.expand(panel, CH1).click();
    await expect(runUi.expand(panel, CH1)).toHaveAttribute('aria-expanded', 'true');
    await runUi.expand(panel, CH2).click();
    await expect(runUi.questions(panel)).toHaveCount(5);
    const first = runUi.question(panel, 1, 1);
    await expect(first).toBeVisible();
    await expect(first).toHaveAccessibleName(
      new RegExp(`^1장 1번 · ${escapeRegExp(rangeStem(s.label, 1, 1).slice(0, 20))}`),
    );
    for (const n of [4, 5, 6]) await expect(runUi.question(panel, 1, n)).toHaveCount(0);
    await expect(runUi.question(panel, 2, 3)).toHaveCount(0); // the merged duplicate
    // The list shows only a stem prefix: compare prefixes (a full stem would never be there).
    for (const n of [4, 5, 6]) {
      await expect(panel).not.toContainText(rangeStem(s.label, 1, n).slice(0, 30));
    }

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.getByRole('button', { name: /^풀기$/ })).toBeVisible();
    expect(new URL(page.url()).searchParams.has('practice')).toBe(false);
  },
);

test(
  'QVIEW-01-AC02 전체 선택 is tri-state over the visible questions and follows the status filter, by mouse and keyboard',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedRangeWorkspace(workspaceFactory, 'qview01-ac02');
    await openHome(page, s.viewer, s.workspaceId);
    const panel = await openRangePicker(page);
    await expandAll(panel);

    await runUi.selectAll(panel).click();
    await expect(runUi.selected(panel, 5)).toBeVisible();
    await expect(runUi.selectAll(panel)).toBeChecked();
    await expect(runUi.chapter(panel, CH1)).toBeChecked();
    await expect(runUi.chapter(panel, CH2)).toBeChecked();

    // Uncheck 1장 2번 (the viewer answered it wrong): everything above it is mixed.
    await runUi.question(panel, 1, 2).click();
    await expect(runUi.selected(panel, 4)).toBeVisible();
    await expect(runUi.selectAll(panel)).toHaveAttribute('aria-checked', 'mixed');
    await expect(runUi.chapter(panel, CH1)).toHaveAttribute('aria-checked', 'mixed');
    await expect(runUi.chapter(panel, CH2)).toBeChecked();

    // 틀린 문제 keeps 1장 2번 (own attempt) and 2장 2번 (only through the merged duplicate, C07);
    // the selection shrinks to the visible ones and 전체 선택 picks the visible ones only.
    if (await runUi.filterToggle(panel).isVisible()) {
      if ((await runUi.filterToggle(panel).getAttribute('aria-expanded')) !== 'true') {
        await runUi.filterToggle(panel).click();
      }
    }
    // All status chips start selected; leave only incorrect selected.
    const filters = panel.getByRole('group', { name: '상태 필터' });
    for (const label of ['안 푼 문제', '본 문제', '맞힌 문제', '다시 풀기']) {
      await filters.getByRole('button', { name: label, exact: true }).click();
    }
    await expandAll(panel);
    await expect(runUi.questions(panel)).toHaveCount(2);
    await expect(runUi.question(panel, 1, 2)).toBeVisible();
    await expect(runUi.question(panel, 2, 2)).toBeVisible();
    await expect(runUi.selected(panel, 1)).toBeVisible();
    await expect(runUi.selectAll(panel)).toHaveAttribute('aria-checked', 'mixed');
    await runUi.selectAll(panel).click();
    await expect(runUi.selected(panel, 2)).toBeVisible();
    await expect(runUi.selectAll(panel)).toBeChecked();

    // Filter off: the questions that were hidden came back unselected.
    for (const label of ['안 푼 문제', '본 문제', '맞힌 문제', '다시 풀기']) {
      await filters.getByRole('button', { name: label, exact: true }).click();
    }
    await expandAll(panel);
    await expect(runUi.questions(panel)).toHaveCount(5);
    await expect(runUi.selected(panel, 2)).toBeVisible();
    await expect(runUi.selectAll(panel)).toHaveAttribute('aria-checked', 'mixed');
    await runUi.selectAll(panel).click();
    await expect(runUi.selected(panel, 5)).toBeVisible();
    await runUi.selectAll(panel).click();
    await expect(runUi.selected(panel, 0)).toBeVisible();
    await expect(runUi.selectAll(panel)).not.toBeChecked();
    await expect(runUi.start(panel)).toBeDisabled();

    // Keyboard only: Space toggles 전체 선택, Tab reaches a question checkbox, Space unchecks it.
    await runUi.selectAll(panel).focus();
    await page.keyboard.press('Space');
    await expect(runUi.selected(panel, 5)).toBeVisible();
    const target = runUi.question(panel, 1, 1);
    for (let i = 0; i < 30; i += 1) {
      if (await target.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(target).toBeFocused();
    await page.keyboard.press('Space');
    await expect(runUi.selected(panel, 4)).toBeVisible();
    await expect(runUi.selectAll(panel)).toHaveAttribute('aria-checked', 'mixed');
    await expect(runUi.start(panel)).toBeEnabled();
  },
);

test(
  'QVIEW-01-AC03 a run keeps the Heatmap order or the server seed order across reloads and announces its progress',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedRangeWorkspace(workspaceFactory, 'qview01-ac03', { studyState: false });
    const heatmapOrder = s.confirmed.map((q) => q.id);
    await openHome(page, s.viewer, s.workspaceId);
    let panel = await openRangePicker(page);
    const ordered = await startAll(page, panel);
    panel = runUi.panel(page);
    await expect(runUi.title(panel, 1, 1)).toBeVisible();
    await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', progressText(1, 5));

    await runUi.skip(panel).click();
    await expect(page).toHaveURL(new RegExp(`[?&]practice=${ordered}(&|$)`));
    await expect(page).toHaveURL(/[?&]i=2(&|$)/);
    await expect(runUi.title(panel, 1, 2)).toBeFocused();
    await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', progressText(2, 5));
    await expect(
      runUi
        .live(panel)
        .filter({ hasText: progressText(2, 5) })
        .first(),
    ).toBeAttached();

    // Positions are Back/Forward steps inside the open panel (QOV-01-AC14 rules).
    await page.goBack();
    await expect(page).toHaveURL(/[?&]i=1(&|$)/);
    await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', progressText(1, 5));
    await page.goForward();
    await expect(page).toHaveURL(/[?&]i=2(&|$)/);
    await expect(runUi.title(panel, 1, 2)).toBeVisible();

    await page.reload();
    panel = runUi.panel(page);
    await expect(runUi.title(panel, 1, 2)).toBeVisible();
    await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', progressText(2, 5));
    expect(await runOrder(s.viewer, ordered, 5)).toEqual(heatmapOrder);

    // Close, then start again through the actual unified play entry.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect.poll(() => practiceParam(page)).toBeNull();
    // Closing a changed run refreshes the server-rendered overview; let that navigation settle.
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /^풀기$/ }).click();
    const play = page.getByRole('dialog', { name: /문제 풀기|practice/i });
    const random = play.getByRole('checkbox', { name: /문제 순서 무작위/ });
    await expect(random).not.toBeChecked();
    await random.check();
    await play.getByRole('checkbox', { name: /선택 범위의 모든 문항/ }).check();
    await play.getByRole('button', { name: /다음|next/i }).click();
    await runUi.selectAll(play).check();
    await play.getByRole('button', { name: /시작|start/i }).click();
    await expect(page).toHaveURL(/[?&]practice=[0-9a-f-]{36}(&|$)/);
    await expect(page).toHaveURL(/[?&]i=1(&|$)/);
    const shuffled = practiceParam(page) ?? '';
    expect(shuffled).not.toBe(ordered);
    const order = await runOrder(s.viewer, shuffled, 5);
    expect([...order].sort()).toEqual([...heatmapOrder].sort());
    expect(new Set(order).size).toBe(5);
    expect(order).not.toEqual(heatmapOrder);
    expect(order).toEqual(TEST_SEED_ORDER_5.map((p) => nth(heatmapOrder, p - 1)));
    const run = await getPracticeRun(s.viewer, shuffled);
    expect(run.body).toMatchObject({ random_order: true, seed: PRACTICE_RUN_TEST_SEED, total: 5 });

    // Position 1 of the shuffled run is Heatmap position 3 (1장 3번), also after a reload.
    panel = runUi.panel(page);
    await expect(runUi.title(panel, 1, 3)).toBeVisible();
    await page.reload();
    await expect(runUi.title(runUi.panel(page), 1, 3)).toBeVisible();
    expect(await runOrder(s.viewer, shuffled, 5)).toEqual(order);

    // 시작 replaced the range step's entry (user decision 2026-11-02): one Back closes the panel,
    // and Forward never reopens it.
    await page.goBack();
    await expect(runUi.panel(page)).toBeHidden();
    await expect.poll(() => practiceParam(page)).toBeNull();
    await page.goForward();
    await expect(runUi.panel(page)).toBeHidden();
    await expect.poll(() => practiceParam(page)).toBeNull();
  },
);

test(
  'QVIEW-01-AC04 a bank run hides answers before submit, grades by option id, self-grades essays and shows read-only results',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('qview01-ac04');
    const explanation = `해설 ${label}: 증발은 액체가 기체로 변하는 현상이다.`;
    const accepted = `Evaporation${randomUUID().slice(0, 6)}`;
    const s = await seedFlat(workspaceFactory, 'qview01-ac04', [
      flatMcq(label, 1, explanation),
      {
        question_type: 'SHORT_ANSWER',
        stem: `${label}-2 단답: 물이 기체로 변하는 현상은?`,
        accepted_answers: [accepted],
        explanation: `${label}-2 해설`,
      },
      essay(label, 3),
    ]);
    const [mcq, short] = [nth(s.questions, 0), nth(s.questions, 1)];
    expect((await overviewItem(s.owner, s.workspaceId, mcq.id)).status).toBe('unseen');

    await openHome(page, s.owner, s.workspaceId);
    let panel = await openRangePicker(page);
    const capture = captureResponses(page);
    const runId = await startAll(page, panel);
    panel = runUi.panel(page);
    await expect(runUi.option(panel, correctText(mcq))).toBeVisible();
    await expect(panel).not.toContainText(explanation);
    const before = await capture.stop();
    expect(before.some((c) => /practice-runs\/[^/]+\/items\/1$/.test(c.path))).toBe(true);
    expect(before.some((c) => /practice-sessions$/.test(c.path))).toBe(true);
    expect(leaks(before, [explanation, accepted])).toEqual([]);
    const item = await s.owner.api.request('GET', `/practice-runs/${runId}/items/1`);
    expect(item.status).toBe(200);
    expect(answerKeysIn(item.body)).toEqual([]);
    expect(item.text).not.toContain(explanation);

    // A wrong answer, chosen by its text wherever the shuffle put it, graded by its stable id.
    const wrong = wrongOption(mcq);
    await answerMcq(panel, wrong.text, RESULT_TEXT.incorrect);
    // The correct option's row says so in text (UX7-QDISPLAY "정답", described-by), not by color.
    await expect(runUi.option(panel, correctText(mcq))).toHaveAccessibleDescription(
      /정답|correct/i,
    );
    await expect(runUi.option(panel, wrong.text)).toHaveAccessibleDescription(/내 선택|your/i);
    await expect(panel).toContainText(explanation);
    const [attempt] = await listAttempts(s.owner, mcq.id);
    expect(attempt).toMatchObject({ result: 'incorrect' });
    expect(attempt?.submitted_answer.selected_option_ids).toEqual([wrong.id]);

    await runUi.next(panel).click();
    await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', progressText(2, 3));
    await expect(runUi.answerText(panel)).toBeVisible();
    await runUi.skip(panel).click(); // viewed, not answered
    await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', progressText(3, 3));
    await answerEssay(panel, `${label} 증발과 응결, 강수가 반복된다.`);
    await runUi.selfGradeCorrect(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);

    // Back to the first position: the submitted answer and result, read-only, no 제출.
    await runUi.previous(panel).click();
    await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', progressText(2, 3));
    await runUi.previous(panel).click();
    await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', progressText(1, 3));
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.incorrect);
    await expect(runUi.option(panel, wrong.text)).toBeChecked();
    await expect(runUi.submit(panel)).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    const dot = overviewUi.dot(page, 1);
    await expect(dot).toHaveAccessibleName(/오답|incorrect/i);
    expect((await overviewItem(s.owner, s.workspaceId, mcq.id)).status).toBe('incorrect');
    expect((await overviewItem(s.owner, s.workspaceId, short.id)).status).toBe('viewed');
    await expect(overviewUi.dot(page, 2)).toHaveAccessibleName(/(?<!미)열람|본 문제|viewed/i);
  },
);

test(
  'QVIEW-01-AC05 a mock exam run uses the same viewer without study toggles and records only mock attempts',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('qview01-ac05');
    const owner = await workspaceFactory.member('qview01-ac05');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const ch1 = await outlineNodeId(owner, documentId, CH1);
    const ch2 = await outlineNodeId(owner, documentId, CH2);
    // MCQs with explanations: the mock copies carry them, so the result can show one.
    // 1장: 1-4, 2장: 5-7, no chapter: 8-10.
    const bank: Question[] = [];
    for (let n = 1; n <= 10; n += 1) {
      const chapterId = n <= 4 ? ch1 : n <= 7 ? ch2 : null;
      bank.push(
        await createQuestion(owner, ws.id, {
          ...flatMcq(label, n),
          question_number: n,
          chapter_id: chapterId,
        }),
      );
    }
    const name = `모의 ${label}`;
    // 1장 1·2번, 2장 5번 and 8번 (no chapter).
    const exam = await createShuffleMockExam(
      owner,
      ws.id,
      name,
      [0, 1, 4, 7].map((i) => bank[i]?.id ?? ''),
      4,
    );
    const overviewBefore = await getOverview(owner, ws.id);
    const attemptsBefore = questionAttemptCount(ws.id);

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id, 'panel=mock-exams'));
    const list = page.getByRole('dialog', { name: /^(모의고사|mock exams?)$/i });
    await expect(list).toBeVisible();
    const row = list.getByRole('listitem').filter({ hasText: name });
    await row.getByRole('button', { name: /^(풀기|practi[sc]e|start)$/i }).click();

    let panel = runUi.panel(page);
    await expect(panel.getByRole('heading', { name: new RegExp(`${name} 풀기`) })).toBeVisible();
    await expect(page).toHaveURL(/[?&]source=mock(&|$)/);
    await expect(page).toHaveURL(new RegExp(`[?&]mock=${exam.id}(&|$)`));
    // Grouped by source chapter like the bank's range step: 1장, 2장, then 챕터 없음.
    await expect(
      panel.getByRole('list', { name: /^(범위|range)$/i }).getByRole('listitem'),
    ).toHaveText([
      new RegExp(`^${CH1} · 2문제`),
      new RegExp(`^${CH2} · 1문제`),
      /^(챕터 없음|no chapter) · 1문제/i,
    ]);
    for (const title of [CH1, CH2, '챕터 없음']) {
      await expect(runUi.chapter(panel, title)).toBeChecked();
    }
    await expandAll(panel);
    await expect(mockBoxes(panel)).toHaveCount(4);
    await expect(runUi.selectAll(panel)).toBeChecked();
    for (const box of await mockBoxes(panel).all()) await expect(box).toBeChecked();
    // A whole chapter off: the run starts from single question ids (no `chapter_ids`).
    await runUi.chapter(panel, '챕터 없음').uncheck();
    await expect(runUi.selected(panel, 3)).toBeVisible();
    const created = page.waitForRequest(
      (r) => r.method() === 'POST' && /\/api\/workspaces\/[^/]+\/practice-runs$/.test(r.url()),
    );
    await runUi.random(panel).check();
    await runUi.start(panel).click();
    const sent = (await created).postDataJSON() as { range: Record<string, unknown> };
    expect(sent.range).not.toHaveProperty('chapter_ids');
    expect(sent.range['question_ids']).toHaveLength(3);
    await expect(page).toHaveURL(/[?&]practice=[0-9a-f-]{36}(&|$)/);

    panel = runUi.panel(page);
    for (let k = 1; k <= 3; k += 1) {
      await expect(runUi.mockTitle(panel, k)).toBeVisible();
      await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', progressText(k, 3));
      await expect(runUi.favorite(panel)).toHaveCount(0);
      await expect(runUi.retryToggle(panel)).toHaveCount(0);
      await panel.getByRole('radio').first().check();
      await runUi.submit(panel).click();
      await expect(runUi.result(panel)).toContainText(/정답|오답|correct|incorrect/i);
      await expect(panel).toContainText(new RegExp(`${escapeRegExp(label)}-\\d+ 해설`));
      if (k < 3) await runUi.next(panel).click();
    }
    await runUi.showResults(panel).click();
    await expect(runUi.restart(panel)).toBeVisible();

    // Only the mock exam recorded the run: the bank and its Heatmap did not change.
    const overviewAfter = await getOverview(owner, ws.id);
    expect(overviewAfter.counts).toEqual(overviewBefore.counts);
    expect(overviewAfter.items.map((i) => [i.question_id, i.status])).toEqual(
      overviewBefore.items.map((i) => [i.question_id, i.status]),
    );
    expect(questionAttemptCount(ws.id)).toBe(attemptsBefore);
    expect(mockAttemptCount(exam.id)).toBe(3);
    await page.keyboard.press('Escape');
    await page.goto(overviewPath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(10);
  },
);

test(
  'QVIEW-01-AC06 the results step counts correct, incorrect, pending and skipped, reopens a position and starts over',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('qview01-ac06');
    const s = await seedFlat(workspaceFactory, 'qview01-ac06', [
      flatMcq(label, 1),
      flatMcq(label, 2),
      flatMcq(label, 3),
      essay(label, 4),
      essay(label, 5),
    ]);
    const [q1, q2] = [nth(s.questions, 0), nth(s.questions, 1)];
    await openHome(page, s.owner, s.workspaceId);
    let panel = await openRangePicker(page);
    const first = await startAll(page, panel);
    panel = runUi.panel(page);

    await answerMcq(panel, correctText(q1), RESULT_TEXT.correct);
    await runUi.next(panel).click();
    await answerMcq(panel, wrongOption(q2).text, RESULT_TEXT.incorrect);
    await runUi.next(panel).click();
    await runUi.skip(panel).click();
    await answerEssay(panel, `${label} 답 4`);
    await runUi.next(panel).click();
    await answerEssay(panel, `${label} 답 5`);
    await runUi.showResults(panel).click();

    await expect(
      runUi.summary(panel, { correct: 1, incorrect: 1, pending: 2, skipped: 1 }),
    ).toBeVisible();
    const rows = runUi.resultRows(panel);
    await expect(rows).toHaveCount(5);
    await expect(nth(await rows.all(), 0).getByLabel(/정답|correct/i)).toHaveText('O');
    await expect(nth(await rows.all(), 1).getByLabel(/오답|incorrect/i)).toHaveText('X');
    await expect(nth(await rows.all(), 2)).toContainText(/건너뜀|skipped/i);
    await expect(nth(await rows.all(), 3)).toContainText(RESULT_TEXT.pending);
    await expect(nth(await rows.all(), 4)).toContainText(RESULT_TEXT.pending);

    // A result row reopens that position read-only.
    await rows.nth(1).getByRole('button').first().click();
    await expect(page).toHaveURL(/[?&]i=2(&|$)/);
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.incorrect);
    await expect(runUi.submit(panel)).toHaveCount(0);

    await goToResults(panel);
    await runUi.restart(panel).click();
    await expect(page).toHaveURL(/[?&]i=1(&|$)/);
    const second = practiceParam(page);
    expect(second).not.toBe(first);
    await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', progressText(1, 5));
    await expect(runUi.submit(panel)).toBeVisible();
    const again = await getPracticeRun(s.owner, second ?? '');
    expect(again.body).toMatchObject({ total: 5, random_order: false });

    // The first run's records did not change.
    const old = await runResults(s.owner, first);
    expect(old.items.map((i) => i.result)).toEqual([
      'correct',
      'incorrect',
      'skipped',
      'pending',
      'pending',
    ]);
    expect(await listAttempts(s.owner, q1.id)).toHaveLength(1);
    expect(await listAttempts(s.owner, q2.id)).toHaveLength(1);
  },
);

test(
  'QVIEW-01-AC07 archived workspaces cannot submit, another user’s run is not found and guests get no 문제 풀기',
  { tag: '@infra' },
  async ({ page, browser, workspaceFactory }) => {
    const label = unique('qview01-ac07');
    const s = await seedFlat(workspaceFactory, 'qview01-ac07', [
      flatMcq(label, 1),
      flatMcq(label, 2),
    ]);
    const other = await seedFlat(workspaceFactory, 'qview01-ac07-other', [flatMcq(label, 9)]);
    const foreignRun = await createPracticeRun(other.owner, other.workspaceId, {
      source: 'bank',
      range: { all: true },
      random_order: false,
    });
    await workspaceFactory.archive(s.owner, s.workspaceId);

    // Archived: the range step, start and the question work; 제출 does not.
    await openHome(page, s.owner, s.workspaceId);
    await openQuestionMenuWithPractice(page);
    let panel = runUi.panel(page);
    await expect(runUi.pickerTitle(panel)).toBeVisible();
    const runId = await startAll(page, panel);
    panel = runUi.panel(page);
    const q1 = nth(s.questions, 0);
    await runUi.option(panel, correctText(q1)).check();
    await expect(runUi.submit(panel)).toBeDisabled();
    await expect(runUi.archivedNotice(panel)).toBeVisible();
    const refused = await openRunSession(s.owner, q1.id, runId, 1);
    expect(refused.status).toBe(403);
    expect((refused.body as Problem | undefined)?.type).toBe(PROBLEM_TYPES.workspaceArchived);

    // Another user's run: not found on screen and through the API.
    await page.goto(practiceRunPath(s.workspaceId, foreignRun.id));
    // The notice may sit in the panel or replace it: look on the whole page.
    await expect(runUi.notFound(page.locator('body'))).toBeVisible();
    expect((await getPracticeRun(s.owner, foreignRun.id)).status).toBe(404);

    // A guest of a share link: no 문제 풀기, the preview is read-only (modal since UX9, HOMEDLG-01).
    const link = await createShareLink(other.owner, other.workspaceId);
    const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const guestPage = await guest.newPage();
      await openShareWithSecret(guestPage, link.id, link.secret);
      await expect(sharedUi.readOnlyNotice(guestPage)).toBeVisible();
      await expect(guestPage.getByText(/^(문제 풀기|practice questions?)$/i)).toHaveCount(0);
      await expect(
        guestPage.getByRole('menuitem', { name: /문제 풀기|practice questions?/i }),
      ).toHaveCount(0);
      await sharedUi.question(guestPage, nth(other.questions, 0).revision.stem).click();
      const preview = sharedUi.questionPanel(guestPage);
      await expect(preview).toBeVisible();
      await expect(preview).toHaveAttribute('aria-modal', 'true');
      await expect(runUi.submit(preview)).toHaveCount(0);
      expect(new URL(guestPage.url()).searchParams.has('practice')).toBe(false);
    } finally {
      await guest.close();
    }
  },
);

test(
  'QVIEW-01-AC08 a question deleted mid-run is skipped and a filter without matches cannot start a run',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('qview01-ac08');
    const s = await seedFlat(workspaceFactory, 'qview01-ac08', [
      flatMcq(label, 1),
      flatMcq(label, 2),
      flatMcq(label, 3),
    ]);
    const [q1, q2, q3] = [nth(s.questions, 0), nth(s.questions, 1), nth(s.questions, 2)];
    await openHome(page, s.owner, s.workspaceId);
    let panel = await openRangePicker(page);
    const runId = await startAll(page, panel);
    panel = runUi.panel(page);
    await s.owner.api.ok('DELETE', `/questions/${q2.id}`, undefined, [204]);

    await answerMcq(panel, correctText(q1), RESULT_TEXT.correct);
    await runUi.next(panel).click();
    await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', progressText(2, 3));
    await expect(runUi.unavailable(panel)).toBeVisible();
    await expect(runUi.submit(panel)).toHaveCount(0);
    await runUi.next(panel).click();
    await answerMcq(panel, correctText(q3), RESULT_TEXT.correct);
    await runUi.showResults(panel).click();
    await expect(
      runUi.summary(panel, { correct: 2, incorrect: 0, pending: 0, skipped: 1 }),
    ).toBeVisible();
    expect((await runResults(s.owner, runId)).items.map((i) => i.result)).toEqual([
      'correct',
      'skipped',
      'correct',
    ]);

    // A new 문제 풀기 with 다시 풀기만 (no question is marked for retry).
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    panel = await openRangePicker(page);
    if ((await runUi.filterToggle(panel).count()) > 0) {
      if ((await runUi.filterToggle(panel).getAttribute('aria-expanded')) !== 'true') {
        await runUi.filterToggle(panel).click();
      }
    }
    await runUi.retryFilter(panel).click();
    await expect(runUi.noMatch(panel)).toBeVisible();
    await expect(runUi.resetFilters(panel)).toBeVisible();
    await expect(runUi.start(panel)).toBeDisabled();

    // Straight to the API: 409 no-matching-questions and no run row.
    const runs = practiceRunCount(s.owner.user.id);
    const res = await requestPracticeRun(s.owner, s.workspaceId, {
      source: 'bank',
      range: { all: true, filters: { retry: true } },
      random_order: false,
    });
    expect(res.status).toBe(409);
    expect((res.body as Problem | undefined)?.type).toBe(RUN_PROBLEMS.noMatching);
    expect(practiceRunCount(s.owner.user.id)).toBe(runs);
  },
);

/**
 * Every rendered modal panel: CSS, not role, so a panel Radix hid under another modal (aria-hidden)
 * still counts. The practice panel (`?question=`) and the run panel are the home's modal panels.
 */
function modalPanels(page: Page): Locator {
  return page.locator('[role="dialog"][aria-modal="true"]');
}

function questionParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get('question');
}

/**
 * Waits for the home to settle after a Back or Forward. When Next's router has no cached copy of
 * the entry a traversal restores, it reads that page again (an RSC request without the prefetch
 * header) and commits it to the history once the response is in — a same-document navigation a
 * `page.goto` started meanwhile is interrupted by (the WebKit flake of QVIEW-01-AC09). Settled:
 * no such read in flight, a main-frame navigation (its commit) after the last one started, and
 * the entry stamped with the panel history's marks again (PanelHistory.stamp).
 */
function historySettler(page: Page): () => Promise<void> {
  let reading = 0;
  let uncommitted = false;
  const isRead = (request: Request) => {
    const headers = request.headers();
    return (
      request.resourceType() !== 'document' &&
      headers['rsc'] !== undefined &&
      headers['next-router-prefetch'] === undefined
    );
  };
  page.on('request', (request) => {
    if (!isRead(request)) return;
    reading += 1;
    uncommitted = true;
  });
  const settle = (request: Request) => {
    if (isRead(request)) reading -= 1;
  };
  page.on('requestfinished', settle);
  page.on('requestfailed', settle);
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) uncommitted = false;
  });
  return async () => {
    await expect.poll(() => reading === 0 && !uncommitted).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state: unknown = window.history.state;
          return typeof state === 'object' && state !== null && '__quizPanelPos' in state;
        }),
      )
      .toBe(true);
  };
}

test(
  'QVIEW-01-AC09 the practice panel and range practice are never open together; a link with both opens the run',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('qview01-ac09');
    const s = await seedFlat(workspaceFactory, 'qview01-ac09', [
      flatMcq(label, 1),
      flatMcq(label, 2),
    ]);
    const [q1, q2] = [nth(s.questions, 0), nth(s.questions, 1)];
    const run = await createPracticeRun(s.owner, s.workspaceId, {
      source: 'bank',
      range: { all: true },
      random_order: false,
    });
    await signInAs(page, s.owner.user);
    const settled = historySettler(page);
    await page.goto('/workspaces');

    // A link carrying both opens only the run (the later intent); `question` leaves the URL.
    await page.goto(`${practiceRunPath(s.workspaceId, run.id, 2)}&question=${q1.id}`);
    let panel = runUi.panel(page);
    await expect(modalPanels(page)).toHaveCount(1);
    await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', progressText(2, 2));
    expect(questionParam(page)).toBeNull();
    expect(practiceParam(page)).toBe(run.id);
    // One Back closes the run and nothing else is left open; Forward reopens neither panel.
    await page.goBack();
    await settled();
    await expect(modalPanels(page)).toHaveCount(0);
    expect(practiceParam(page)).toBeNull();
    expect(questionParam(page)).toBeNull();
    await page.goForward();
    await settled();
    await expect(modalPanels(page)).toHaveCount(0);
    expect(practiceParam(page)).toBeNull();
    expect(questionParam(page)).toBeNull();

    // The same for the range step.
    await page.goto(`${overviewPath(s.workspaceId)}?question=${q2.id}&practice=new&source=bank`);
    panel = runUi.panel(page);
    await expect(runUi.pickerTitle(panel)).toBeVisible();
    await expect(modalPanels(page)).toHaveCount(1);
    expect(questionParam(page)).toBeNull();

    // Inside a run, a 문제별 결과 row reopens a position of the run, never `?question=`.
    await runUi.selectAll(panel).check();
    await runUi.start(panel).click();
    await expect(page).toHaveURL(/[?&]i=1(&|$)/);
    panel = runUi.panel(page);
    await runUi.skip(panel).click();
    await runUi.showResults(panel).click();
    await expect(runUi.resultRows(panel)).toHaveCount(2);
    await runUi.resultRows(panel).nth(0).getByRole('button').first().click();
    await expect(page).toHaveURL(/[?&]i=1(&|$)/);
    await expect(modalPanels(page)).toHaveCount(1);
    expect(questionParam(page)).toBeNull();
    await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', progressText(1, 2));
  },
);
