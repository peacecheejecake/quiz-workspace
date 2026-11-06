// UX12-RETRYINPLACE (docs/screens/ux12-retry-in-place.md): 다시 풀기 turns the position back to
// solving in the same panel. Contract half:
// tests/integration/questions/practice_runs/test_practice_runs_contract.py (UX12-RETRYINPLACE).
import type { Locator, Page } from '@playwright/test';
import { mockUi } from '../fixtures/mock-exams.ts';
import {
  closeUnfinishedRun,
  createPracticeRun,
  createShuffleMockExam,
  getPracticeRun,
  mockAttemptCount,
  practiceRunPath,
  questionAttemptCount,
  runResults,
  runUi,
} from '../fixtures/practice-runs.ts';
import {
  createNumberedQuestions,
  expect,
  homePath,
  RESULT_TEXT,
  signInAs,
  test,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const AGAIN = /^다시 풀기$/;
const again = (panel: Locator) => panel.getByRole('button', { name: AGAIN });

function nth(questions: readonly Question[], index: number): Question {
  const question = questions[index];
  if (!question) throw new Error(`no question ${index}`);
  return question;
}

function optionText(question: Question, correct: boolean): string {
  const ids = question.revision.correct_option_ids ?? [];
  const option = question.revision.options.find((o) => ids.includes(o.id) === correct);
  if (!option) throw new Error('no option');
  return option.text;
}

async function mockRun(owner: Member, workspaceId: string, sources: readonly Question[]) {
  const exam = await createShuffleMockExam(
    owner,
    workspaceId,
    '다시 풀기 시험',
    sources.map((q) => q.id),
    sources.length,
  );
  const run = await createPracticeRun(owner, workspaceId, {
    source: 'mock',
    mock_exam_id: exam.id,
    range: { all: true },
    random_order: false,
  });
  return { exam, run };
}

async function openMock(page: Page, workspaceId: string, runId: string): Promise<Locator> {
  await page.goto(homePath(workspaceId, `panel=mock-exams&practice=${runId}&i=1`));
  const panel = runUi.panel(page);
  await expect(runUi.mockTitle(panel, 1)).toBeVisible();
  return panel;
}

async function submitFirstRadio(panel: Locator): Promise<void> {
  await panel.getByRole('radio').first().check();
  await runUi.submit(panel).click();
  await expect(runUi.result(panel)).toBeVisible();
}

test(
  'UX12-RETRYINPLACE-AC01 다시 풀기 clears the position in the same panel',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-inplace-01');
    const ws = await workspaceFactory.create(owner);
    const sources = await createNumberedQuestions(owner, ws.id, 'ux12-inplace-01', 2);
    const { run } = await mockRun(owner, ws.id, sources);
    await signInAs(page, owner.user);
    const panel = await openMock(page, ws.id, run.id);
    await submitFirstRadio(panel);

    await again(panel).click();
    await expect(runUi.submit(panel)).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(runUi.result(panel)).toHaveCount(0);
    await expect(panel.getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(runUi.mockTitle(panel, 1)).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`practice=${run.id}&i=1`));
  },
);

test(
  'UX12-RETRYINPLACE-AC02 the latest submission is the position result; the earlier attempt stays',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-inplace-02');
    const ws = await workspaceFactory.create(owner);
    const sources = await createNumberedQuestions(owner, ws.id, 'ux12-inplace-02', 1);
    const question = nth(sources, 0);
    const { exam, run } = await mockRun(owner, ws.id, sources);
    await signInAs(page, owner.user);
    const panel = await openMock(page, ws.id, run.id);

    await runUi.option(panel, optionText(question, false)).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.incorrect);
    await again(panel).click();
    await runUi.option(panel, optionText(question, true)).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);

    await runUi.showResults(panel).click();
    await expect(
      runUi.summary(panel, { correct: 1, incorrect: 0, pending: 0, skipped: 0 }),
    ).toBeVisible();
    expect((await runResults(owner, run.id)).items[0]?.result).toBe('correct');
    expect(mockAttemptCount(exam.id)).toBe(2);
    expect(questionAttemptCount(ws.id)).toBe(0);
  },
);

test(
  'UX12-RETRYINPLACE-AC03 a reload and 이전 문제 keep the solving state',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-inplace-03');
    const ws = await workspaceFactory.create(owner);
    const sources = await createNumberedQuestions(owner, ws.id, 'ux12-inplace-03', 2);
    const { run } = await mockRun(owner, ws.id, sources);
    await signInAs(page, owner.user);
    const panel = await openMock(page, ws.id, run.id);
    await submitFirstRadio(panel);
    await again(panel).click();
    await expect(runUi.submit(panel)).toBeVisible();

    await page.reload();
    await expect(runUi.submit(panel)).toBeVisible();
    await expect(runUi.result(panel)).toHaveCount(0);

    await runUi.next(panel).click();
    await expect(runUi.mockTitle(panel, 2)).toBeVisible();
    await runUi.previous(panel).click();
    await expect(runUi.mockTitle(panel, 1)).toBeVisible();
    await expect(runUi.submit(panel)).toBeVisible();
    await expect(runUi.result(panel)).toHaveCount(0);
  },
);

test(
  'UX12-RETRYINPLACE-AC04 a reopened position leaves the progress and 이어 풀기 opens it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-inplace-04');
    const ws = await workspaceFactory.create(owner);
    const sources = await createNumberedQuestions(owner, ws.id, 'ux12-inplace-04', 3);
    const run = await createPracticeRun(owner, ws.id, {
      source: 'bank',
      range: { question_ids: sources.map((q) => q.id) },
      random_order: false,
    });
    await signInAs(page, owner.user);
    await page.goto(practiceRunPath(ws.id, run.id, 1));
    const panel = runUi.panel(page);
    await runUi.option(panel, optionText(nth(sources, 0), true)).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toBeVisible();
    await again(panel).click();
    await expect(runUi.submit(panel)).toBeVisible();
    await closeUnfinishedRun(panel);

    await expect.poll(async () => (await getPracticeRun(owner, run.id)).body?.answered).toBe(0);
    await page.goto(homePath(ws.id, 'panel=mock-exams'));
    const row = mockUi
      .dialog(page)
      .getByRole('list', { name: /^(모의고사 목록|mock exams?)$/i })
      .getByRole('listitem');
    await expect(row).toContainText('0/3');
    await row.getByRole('button').first().click();
    await expect(page).toHaveURL(new RegExp(`practice=${run.id}&i=1`));
    await expect(runUi.submit(runUi.panel(page))).toBeVisible();
  },
);

test(
  'UX12-RETRYINPLACE-AC05 each 다시 풀기 of a 보기 섞기 run draws a new order, graded by option id',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-inplace-05');
    const ws = await workspaceFactory.create(owner);
    const sources = await createNumberedQuestions(owner, ws.id, 'ux12-inplace-05', 1);
    const question = nth(sources, 0);
    const { run } = await mockRun(owner, ws.id, sources);
    await signInAs(page, owner.user);
    const panel = await openMock(page, ws.id, run.id);

    const orders = new Set<string>();
    for (let attempt = 0; attempt < 8 && orders.size < 2; attempt += 1) {
      await expect(runUi.submit(panel)).toBeVisible();
      orders.add((await panel.getByRole('radio').allTextContents()).join('|'));
      await runUi.option(panel, optionText(question, true)).check();
      await runUi.submit(panel).click();
      await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
      await again(panel).click();
      await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toHaveCount(
        0,
      );
    }
    expect(orders.size).toBeGreaterThan(1);
  },
);

test(
  'UX12-RETRYINPLACE-AC06 a finished run keeps its record and a reload shows it again',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-inplace-06');
    const ws = await workspaceFactory.create(owner);
    const sources = await createNumberedQuestions(owner, ws.id, 'ux12-inplace-06', 1);
    const question = nth(sources, 0);
    const { exam, run } = await mockRun(owner, ws.id, sources);
    await signInAs(page, owner.user);
    const panel = await openMock(page, ws.id, run.id);
    await runUi.option(panel, optionText(question, false)).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.incorrect);
    await owner.api.ok('POST', `/practice-runs/${run.id}/finish`, {}, [200]);
    const before = await runResults(owner, run.id);
    await page.reload();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.incorrect);

    await again(panel).click();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await runUi.option(panel, optionText(question, true)).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
    expect(await runResults(owner, run.id)).toEqual(before);
    expect(mockAttemptCount(exam.id)).toBe(2);

    await page.reload();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.incorrect);
  },
);
