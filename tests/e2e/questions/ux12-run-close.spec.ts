// UX12-RUNCLOSE (docs/screens/ux12-run-close.md): closing an unfinished run asks first, whichever
// way it was closed; the results step, a finished run, the range step and Back do not.
// Vitest half: apps/web/test/ux12-run-close.test.tsx.
import type { Locator, Page } from '@playwright/test';
import { mockUi } from '../fixtures/mock-exams.ts';
import { drag, expectSettled, line } from '../fixtures/overlay-drag.ts';
import {
  closeUnfinishedRun,
  confirmRunClose,
  createPracticeRun,
  createShuffleMockExam,
  goToResults,
  practiceParam,
  practiceRunPath,
  runCloseUi,
  runUi,
  type PracticeRun,
} from '../fixtures/practice-runs.ts';
import {
  createNumberedQuestions,
  expect,
  homePath,
  signInAs,
  test,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

function firstOption(question: Question | undefined): string {
  const text = question?.revision.options[0]?.text;
  if (!text) throw new Error('no option');
  return text;
}

async function seed(
  owner: Member,
  workspaceId: string,
  prefix: string,
  count = 3,
): Promise<{ readonly questions: readonly Question[]; readonly run: PracticeRun }> {
  const questions = await createNumberedQuestions(owner, workspaceId, prefix, count);
  const run = await createPracticeRun(owner, workspaceId, {
    source: 'bank',
    range: { question_ids: questions.map((q) => q.id) },
    random_order: false,
  });
  return { questions, run };
}

async function solving(page: Page, workspaceId: string, runId: string, n = 1): Promise<Locator> {
  await page.goto(practiceRunPath(workspaceId, runId, n));
  const panel = runUi.panel(page);
  await expect(runUi.title(panel, n)).toBeVisible();
  await expect(runUi.submit(panel)).toBeVisible();
  return panel;
}

async function keepSolving(page: Page, panel: Locator): Promise<void> {
  await runCloseUi.keepSolving(page).click();
  await expect(runCloseUi.dialog(page)).toHaveCount(0);
  await expect(panel).toBeVisible();
}

test(
  'UX12-RUNCLOSE-AC01 the close button asks above the panel with focus on 계속 풀기',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-runclose-01');
    const ws = await workspaceFactory.create(owner);
    const { run } = await seed(owner, ws.id, 'ux12-runclose-01');
    await signInAs(page, owner.user);
    const panel = await solving(page, ws.id, run.id);

    await runUi.close(panel).click();
    const confirm = runCloseUi.dialog(page);
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(/제출한 답은 저장/);
    await expect(confirm).toContainText(/이어 풀기/);
    await expect(runCloseUi.keepSolving(page)).toBeFocused();
    expect(practiceParam(page)).toBe(run.id);
  },
);

test(
  'UX12-RUNCLOSE-AC02 계속 풀기 and Escape keep the question, the choice and the focus',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-runclose-02');
    const ws = await workspaceFactory.create(owner);
    const { questions, run } = await seed(owner, ws.id, 'ux12-runclose-02');
    await signInAs(page, owner.user);
    const panel = await solving(page, ws.id, run.id);
    const choice = runUi.option(panel, firstOption(questions[0]));
    await choice.check();

    await runUi.close(panel).focus();
    await page.keyboard.press('Enter');
    await keepSolving(page, panel);
    await expect(runUi.close(panel)).toBeFocused();
    await expect(choice).toBeChecked();

    await page.keyboard.press('Enter');
    await expect(runCloseUi.dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(runCloseUi.dialog(page)).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(runUi.close(panel)).toBeFocused();
    await expect(choice).toBeChecked();
    expect(practiceParam(page)).toBe(run.id);
  },
);

test(
  'UX12-RUNCLOSE-AC03 닫기 closes the confirm and the panel, back on the opener in a fresh list',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-runclose-03');
    const ws = await workspaceFactory.create(owner);
    const { questions } = await seed(owner, ws.id, 'ux12-runclose-03');
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id, 'panel=mock-exams'));
    const list = mockUi.dialog(page);
    const row = list
      .getByRole('list', { name: /^(모의고사 목록|mock exams?)$/i })
      .getByRole('listitem');
    await expect(row).toContainText('0/3');
    const resume = row.getByRole('button').first();
    await resume.click();

    const panel = runUi.panel(page);
    await expect(runUi.title(panel, 1)).toBeVisible();
    await runUi.option(panel, firstOption(questions[0])).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toBeVisible();

    await closeUnfinishedRun(panel);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(practiceParam(page)).toBeNull();
    await expect(row).toContainText('1/3');
    await expect(resume).toBeFocused();

    await page.goBack();
    await expect(runUi.submit(page.locator('body'))).toHaveCount(0);
    expect(practiceParam(page)).toBeNull();
  },
);

test(
  'UX12-RUNCLOSE-AC04 Escape, the backdrop and a swipe show the same single confirm',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-runclose-04');
    const ws = await workspaceFactory.create(owner);
    const { run } = await seed(owner, ws.id, 'ux12-runclose-04');
    await signInAs(page, owner.user);
    const panel = await solving(page, ws.id, run.id);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(1);
    await keepSolving(page, panel);

    // The top-left corner is backdrop on every layout: the panel sits at the end or the bottom.
    await page.mouse.click(4, 4);
    await expect(page.getByRole('alertdialog')).toHaveCount(1);
    await keepSolving(page, panel);

    const phone = (page.viewportSize()?.width ?? 1280) < 768;
    await drag(panel.getByRole('heading').first(), phone ? line(0, 140) : line(140, 0));
    await expect(page.getByRole('alertdialog')).toHaveCount(1);
    await keepSolving(page, panel);
    await expectSettled(panel);
    expect(practiceParam(page)).toBe(run.id);
  },
);

test(
  'UX12-RUNCLOSE-AC05 results, a finished run, the range step and an all-submitted run close at once',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-runclose-05');
    const ws = await workspaceFactory.create(owner);
    const { questions, run } = await seed(owner, ws.id, 'ux12-runclose-05', 1);
    await signInAs(page, owner.user);

    await page.goto(homePath(ws.id, 'practice=new&source=bank'));
    const picker = runUi.panel(page);
    await expect(runUi.pickerTitle(picker)).toBeVisible();
    await runUi.close(picker).click();
    await expect(picker).toBeHidden();

    const panel = await solving(page, ws.id, run.id);
    await runUi.option(panel, firstOption(questions[0])).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toBeVisible();
    await runUi.close(panel).click();
    await expect(panel).toBeHidden();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    await page.goto(practiceRunPath(ws.id, run.id, 1));
    await expect(runUi.result(panel)).toBeVisible();
    await goToResults(panel);
    await expect(panel.getByRole('heading', { name: /풀이 결과|results/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    await page.goto(practiceRunPath(ws.id, run.id, 1));
    await expect(runUi.result(panel)).toBeVisible();
    await runUi.close(panel).click();
    await expect(panel).toBeHidden();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  },
);

test(
  'UX12-RUNCLOSE-AC06 a saved mock exam run closes through the confirm back to the mock view',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-runclose-06');
    const ws = await workspaceFactory.create(owner);
    const sources = await createNumberedQuestions(owner, ws.id, 'ux12-runclose-06', 2);
    const exam = await createShuffleMockExam(
      owner,
      ws.id,
      '닫기 시험',
      sources.map((q) => q.id),
      2,
    );
    const run = await createPracticeRun(owner, ws.id, {
      source: 'mock',
      mock_exam_id: exam.id,
      range: { all: true },
      random_order: false,
    });
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id, `panel=mock-exams&practice=${run.id}&i=1`));
    const panel = runUi.panel(page);
    await expect(runUi.mockTitle(panel, 1)).toBeVisible();

    await closeUnfinishedRun(panel);
    expect(practiceParam(page)).toBeNull();
    await expect(page).toHaveURL(/panel=mock-exams/);
    await expect(mockUi.dialog(page)).toBeVisible();
  },
);

test(
  'UX12-RUNCLOSE-AC07 Back never asks and drops an open confirm for good',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-runclose-07');
    const ws = await workspaceFactory.create(owner);
    const { run } = await seed(owner, ws.id, 'ux12-runclose-07');
    await signInAs(page, owner.user);
    const panel = await solving(page, ws.id, run.id);

    await runUi.next(panel).click();
    await expect(runUi.title(panel, 2)).toBeVisible();
    await page.goBack();
    await expect(runUi.title(panel, 1)).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    await page.goForward();
    await expect(runUi.title(panel, 2)).toBeVisible();
    await runUi.close(panel).click();
    await expect(runCloseUi.dialog(page)).toBeVisible();
    await page.goBack();
    await expect(runCloseUi.dialog(page)).toHaveCount(0);
    await expect(runUi.title(panel, 1)).toBeVisible();
    await page.goForward();
    await expect(runUi.title(panel, 2)).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    await runUi.close(panel).click();
    await confirmRunClose(page);
    await expect(panel).toBeHidden();
  },
);
