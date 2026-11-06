// UX12-RETRYOPEN — a question marked 다시 풀기 opens to be answered, without its last result
// (docs/screens/ux12-retry-open.md). The server decides, so the opening response is checked too;
// the contract is in tests/integration/questions/test_practice_open.py.
import type { Locator, Page } from '@playwright/test';
import { notePanelPath, noteUi } from '../fixtures/chapter-notes.ts';
import { noteSetup } from '../fixtures/highlights.ts';
import { createPracticeRun, practiceRunPath, runUi } from '../fixtures/practice-runs.ts';
import {
  answerCorrectly,
  createQuestion,
  expect,
  historyPath,
  historyUi,
  JOB_TIMEOUT_MS,
  listAttempts,
  numberedMcq,
  overviewItem,
  overviewPath,
  overviewUi,
  panelUi,
  RESULT_TEXT,
  setMyState,
  signInAs,
  startPractice,
  submitPractice,
  test,
  type E2EFixtures,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const AGAIN = /^다시 풀기$|^solve again$/i;
const EXPLANATION = /UX12-RETRYOPEN 해설/;
const explained = { explanation: 'UX12-RETRYOPEN 해설: 첫 보기가 답이다.' };

interface Seeded {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly questions: Question[];
}

async function seed(
  workspaceFactory: E2EFixtures['workspaceFactory'],
  label: string,
  count: number,
): Promise<Seeded> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const questions: Question[] = [];
  for (let n = 1; n <= count; n += 1) {
    questions.push(
      await createQuestion(owner, ws.id, numberedMcq(`${label}-${Date.now()}`, n, 0, explained)),
    );
  }
  return { owner, workspaceId: ws.id, questions };
}

/** Solved correctly, then marked 다시 풀기. */
async function markSolved(owner: Member, question: Question): Promise<void> {
  await answerCorrectly(owner, question);
  await setMyState(owner, question.id, { needs_retry: true });
}

function optionText(question: Question, index: number): string {
  const text = question.revision.options[index]?.text;
  if (!text) throw new Error(`no option ${index}`);
  return text;
}

function only(s: Seeded): Question {
  const [question] = s.questions;
  if (!question) throw new Error('no question');
  return question;
}

async function openHome(page: Page, s: Seeded): Promise<void> {
  await signInAs(page, s.owner.user);
  await page.goto(overviewPath(s.workspaceId));
  await expect(overviewUi.heatmap(page)).toBeVisible();
}

async function openDot(page: Page, n: number): Promise<Locator> {
  await overviewUi.dot(page, n).click();
  const panel = panelUi.numbered(page, n);
  await expect(panel).toBeVisible();
  return panel;
}

async function closePanel(panel: Locator): Promise<void> {
  await panelUi.close(panel).click();
  await expect(panel).toBeHidden();
}

/** The panel is ready to be answered: nothing chosen, no result, no explanation. */
async function expectClean(panel: Locator): Promise<void> {
  await expect(panelUi.submit(panel)).toBeDisabled();
  for (const option of await panelUi.options(panel).all()) await expect(option).not.toBeChecked();
  await expect(panel.getByRole('region', { name: '해설' })).toHaveCount(0);
  await expect(panel).not.toContainText(EXPLANATION);
  await expect(panel).not.toContainText(RESULT_TEXT.correct);
  await expect(panel).not.toContainText(RESULT_TEXT.incorrect);
}

test(
  'UX12-RETRYOPEN-AC01 a solved question marked 다시 풀기 opens without its result',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-retryopen-1', 1);
    await markSolved(s.owner, only(s));
    await openHome(page, s);

    const opening = page.waitForResponse((r) => r.url().endsWith('/practice-open'));
    const panel = await openDot(page, 1);
    const opened = (await (await opening).json()) as Record<string, unknown>;
    expect(opened.result).toBeNull();
    expect(opened.submitted_answer ?? null).toBeNull();
    expect(JSON.stringify(opened)).not.toMatch(EXPLANATION);

    await expectClean(panel);
    await expect(panelUi.retryOff(panel)).toHaveAttribute('data-state', 'on');
    await expect(panel.getByRole('button', { name: AGAIN })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  },
);

test(
  'UX12-RETRYOPEN-AC02 submitting shows the result, keeps the mark and opens clean again',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-retryopen-2', 1);
    const question = only(s);
    await markSolved(s.owner, question);
    await openHome(page, s);

    let panel = await openDot(page, 1);
    await panelUi.option(panel, optionText(question, 0)).check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await expect(panel).toContainText(EXPLANATION);
    await closePanel(panel);

    await expect(overviewUi.dot(page, 1)).toHaveAttribute('data-status', 'retry');
    expect(await overviewItem(s.owner, s.workspaceId, question.id)).toMatchObject({
      needs_retry: true,
      last_graded_result: 'correct',
    });
    expect((await listAttempts(s.owner, question.id)).map((a) => a.result)).toEqual([
      'correct',
      'correct',
    ]);

    panel = await openDot(page, 1);
    await expectClean(panel);
  },
);

test(
  'UX12-RETRYOPEN-AC03 a wrong answer clears the mark and the question still opens clean',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-retryopen-3', 1);
    const question = only(s);
    await markSolved(s.owner, question);
    await openHome(page, s);

    let panel = await openDot(page, 1);
    await panelUi.option(panel, optionText(question, 1)).check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.incorrect);
    await closePanel(panel);
    expect(await overviewItem(s.owner, s.workspaceId, question.id)).toMatchObject({
      needs_retry: false,
      last_graded_result: 'incorrect',
    });

    panel = await openDot(page, 1);
    await expectClean(panel);
    await panelUi.reveal(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.incorrect);
    await expect(panel).toContainText(EXPLANATION);
  },
);

test(
  'UX12-RETRYOPEN-AC04 clearing the mark does not bring the result back on opening',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-retryopen-4', 1);
    const marked = only(s);
    await markSolved(s.owner, marked);
    await openHome(page, s);

    let panel = await openDot(page, 1);
    await expectClean(panel);
    await panelUi.retryOff(panel).click();
    await expect(panelUi.retryOn(panel)).toBeVisible();
    await expect
      .poll(async () => (await overviewItem(s.owner, s.workspaceId, marked.id)).needs_retry)
      .toBe(false);
    await closePanel(panel);

    panel = await openDot(page, 1);
    await expectClean(panel);
    await panelUi.reveal(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
  },
);

test(
  'UX12-RETRYOPEN-AC05 a history link opens the question clean and the list keeps the result',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-retryopen-5', 1);
    await markSolved(s.owner, only(s));
    await signInAs(page, s.owner.user);
    await page.goto(historyPath(s.workspaceId));

    const attempts = historyUi.ofKind(page, 'attempt');
    await expect(attempts).toHaveCount(1);
    await expect(attempts.first()).toContainText(RESULT_TEXT.correct);
    await attempts.first().getByRole('link').first().click();
    const panel = panelUi.numbered(page, 1);
    await expect(panel).toBeVisible();
    await expectClean(panel);
  },
);

test(
  'UX12-RETRYOPEN-AC06 a chapter note footnote opens the question clean',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(6 * JOB_TIMEOUT_MS);
    const s = await noteSetup(workspaceFactory, 'ux12-retryopen-6', { count: 2 });
    const [cited] = s.questions;
    if (!cited) throw new Error('no question');
    await markSolved(s.owner, cited);
    await signInAs(page, s.owner.user);
    await page.goto(notePanelPath(s.workspaceId, s.ch1));
    const note = noteUi.panel(page);
    await expect(note).toBeVisible();

    await note
      .getByRole('link', { name: /^(각주|footnote)\s*1$/i })
      .first()
      .click();
    const panel = panelUi.numbered(page, 1);
    await expect(panel).toBeVisible();
    await expect(panelUi.submit(panel)).toBeDisabled();
    await expect(panel.getByRole('region', { name: '해설' })).toHaveCount(0);
    await expect(panelUi.retryOff(panel)).toBeVisible();
  },
);

test(
  'UX12-RETRYOPEN-AC07 a run position keeps its own record whatever the mark says',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-retryopen-7', 2);
    const [first] = s.questions as [Question];
    await markSolved(s.owner, first);
    const run = await createPracticeRun(s.owner, s.workspaceId, {
      source: 'bank',
      range: { all: true },
      random_order: false,
    });
    await signInAs(page, s.owner.user);
    await page.goto(practiceRunPath(s.workspaceId, run.id, 1));
    const panel = runUi.panel(page);
    await expect(runUi.submit(panel)).toBeVisible();
    await expect(runUi.result(panel)).toHaveCount(0);
    await expect(panel).not.toContainText(EXPLANATION);

    await runUi.option(panel, optionText(first, 0)).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await runUi.next(panel).click();
    await expect(runUi.result(panel)).toHaveCount(0);
    await runUi.previous(panel).click();

    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await expect(panel).toContainText(EXPLANATION);
    await expect(runUi.option(panel, optionText(first, 0))).toBeChecked();
    expect((await overviewItem(s.owner, s.workspaceId, first.id)).needs_retry).toBe(true);
  },
);

test(
  'UX12-RETRYOPEN-AC08 a pending submission stays on screen until it is graded',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-retryopen-8');
    const ws = await workspaceFactory.create(owner);
    const question = await createQuestion(owner, ws.id, {
      question_type: 'ESSAY',
      stem: `ux12-retryopen-8-${Date.now()} 물의 순환을 서술하시오.`,
      rubric: '증발과 응결을 언급',
      question_number: 1,
    });
    const first = await startPractice(owner, question.id);
    await submitPractice(owner, first.id, { answer_text: '첫 답안' });
    await owner.api.ok('POST', `/practice-sessions/${first.id}/self-grade`, { result: 'correct' });
    await setMyState(owner, question.id, { needs_retry: true });
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await expect(overviewUi.heatmap(page)).toBeVisible();

    let panel = await openDot(page, 1);
    await expect(panelUi.answerText(panel)).toHaveValue('');
    await panelUi.answerText(panel).fill('새 답안');
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.pending);
    await closePanel(panel);

    panel = await openDot(page, 1);
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.pending);
    await panelUi.selfGradeCorrect(panel).click();
    await expect(panelUi.selfGradeCorrect(panel)).toHaveCount(0);
    await closePanel(panel);

    panel = await openDot(page, 1);
    await expect(panelUi.answerText(panel)).toHaveValue('');
    await expect(panelUi.submit(panel)).toBeDisabled();
  },
);
