// RETRY-01 — `다시 풀기` only on questions whose last graded result is correct (RETRY-CORRECT
// 2026-11-04), docs/screens/retry-correct.md; rules docs/questions.md §16.
//
// Each test signs in its own owner and works in its own workspace. The toggle is not rendered
// (rather than disabled) for a question that was not answered correctly last, so the checks are
// `toHaveCount(0)` on the toggle's role/name locators (panelUi.retryOn/retryOff, runUi.retryToggle).
// API and DB rules the browser cannot observe (409 `retry-requires-correct`, the grading trigger,
// merged duplicates, the data migration) are in tests/integration/questions/
// test_retry_correct_api_contract.py and supabase/tests/21_retry_correct.test.sql.
import type { Locator, Page } from '@playwright/test';
import {
  createPracticeRun,
  practiceRunPath,
  progressText,
  runUi,
} from '../fixtures/practice-runs.ts';
import { seedOwnerStudyState } from '../fixtures/sharing.ts';
import {
  createNumberedQuestions,
  expect,
  overviewItem,
  overviewPath,
  overviewUi,
  panelUi,
  RESULT_TEXT,
  signInAs,
  test,
  type E2EFixtures,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

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
  const questions = await createNumberedQuestions(owner, ws.id, label, count);
  return { owner, workspaceId: ws.id, questions };
}

function optionText(question: Question, index: number): string {
  const option = question.revision.options[index];
  if (!option) throw new Error(`no option ${index}`);
  return option.text;
}

/** Question n (1-based) of the seeded workspace. */
function q(s: Seeded, n: number): Question {
  const found = s.questions[n - 1];
  if (!found) throw new Error(`no question ${n}`);
  return found;
}

/** The Heatmap dot by id: under the modal panel it is out of the accessibility tree. */
function dotOf(page: Page, question: Question): Locator {
  return page.locator(`[data-question-id="${question.id}"]:visible`);
}

async function openPanel(page: Page, n: number): Promise<Locator> {
  await overviewUi.dot(page, n).click();
  const panel = panelUi.numbered(page, n);
  await expect(panel).toBeVisible();
  return panel;
}

/** Answers the open panel: option 0 is correct (numberedMcq default), option 1 is wrong. */
async function answer(panel: Locator, question: Question, correct: boolean): Promise<void> {
  await panelUi.option(panel, optionText(question, correct ? 0 : 1)).check();
  await panelUi.submit(panel).click();
  await expect(panelUi.result(panel)).toContainText(
    correct ? RESULT_TEXT.correct : RESULT_TEXT.incorrect,
  );
}

const ANOTHER_TRY = /한 번 더 풀기|solve again/i;

test(
  'RETRY-01-AC01 the practice panel shows 다시 풀기 only after a correct submission',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'retry01-ac01', 2);
    await signInAs(page, s.owner.user);
    await page.goto(overviewPath(s.workspaceId));
    await expect(overviewUi.heatmap(page)).toBeVisible();

    // Question 1: unseen, then answered correctly.
    let panel = await openPanel(page, 1);
    await expect(panelUi.favoriteOn(panel)).toBeVisible();
    await expect(panelUi.retryOn(panel)).toHaveCount(0);
    await expect(panelUi.retryOff(panel)).toHaveCount(0);
    await answer(panel, q(s, 1), true);
    await expect(panelUi.retryOn(panel)).toBeVisible();
    await expect(panelUi.retryOn(panel)).toHaveAttribute('data-state', 'off');
    await panelUi.retryOn(panel).click();
    await expect(panelUi.retryOff(panel)).toHaveAttribute('data-state', 'on');
    await expect(dotOf(page, q(s, 1))).toHaveAttribute('data-status', 'retry');
    await expect
      .poll(async () => (await overviewItem(s.owner, s.workspaceId, q(s, 1).id)).needs_retry)
      .toBe(true);
    await panelUi.close(panel).click();
    await expect(panel).toBeHidden();

    // Question 2: answered wrong, opened again — still no toggle.
    panel = await openPanel(page, 2);
    await answer(panel, q(s, 2), false);
    await expect(panelUi.retryOn(panel)).toHaveCount(0);
    await expect(panelUi.retryOff(panel)).toHaveCount(0);
    await panelUi.close(panel).click();
    await expect(panel).toBeHidden();
    panel = await openPanel(page, 2);
    await expect(panelUi.favoriteOn(panel)).toBeVisible();
    await expect(panelUi.retryOn(panel)).toHaveCount(0);
    await expect(panelUi.retryOff(panel)).toHaveCount(0);
  },
);

test(
  'RETRY-01-AC02 a later wrong submission removes the toggle and turns the retry flag off',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'retry01-ac02', 1);
    const question = q(s, 1);
    await signInAs(page, s.owner.user);
    await page.goto(overviewPath(s.workspaceId));
    await expect(overviewUi.heatmap(page)).toBeVisible();

    const panel = await openPanel(page, 1);
    await answer(panel, question, true);
    await panelUi.retryOn(panel).click();
    await expect(panelUi.retryOff(panel)).toBeVisible();
    await expect
      .poll(async () => (await overviewItem(s.owner, s.workspaceId, question.id)).needs_retry)
      .toBe(true);

    await panel.getByRole('button', { name: ANOTHER_TRY }).click();
    await answer(panel, question, false);
    await expect(panelUi.retryOn(panel)).toHaveCount(0);
    await expect(panelUi.retryOff(panel)).toHaveCount(0);
    await expect(dotOf(page, question)).toHaveAttribute('data-status', 'incorrect');
    expect(await overviewItem(s.owner, s.workspaceId, question.id)).toMatchObject({
      status: 'incorrect',
      needs_retry: false,
      last_graded_result: 'incorrect',
    });

    // A correct answer brings the toggle back, off.
    await panel.getByRole('button', { name: ANOTHER_TRY }).click();
    await answer(panel, question, true);
    await expect(panelUi.retryOn(panel)).toHaveAttribute('data-state', 'off');
    await panelUi.close(panel).click();
    await page.reload();
    await expect(overviewUi.dot(page, 1)).toHaveAttribute('data-status', 'correct');
  },
);

test(
  'RETRY-01-AC03 range practice shows 다시 풀기 only for a question answered correctly',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'retry01-ac03', 2);
    const run = await createPracticeRun(s.owner, s.workspaceId, {
      source: 'bank',
      range: { all: true },
      random_order: false,
    });
    await signInAs(page, s.owner.user);
    await page.goto(practiceRunPath(s.workspaceId, run.id, 1));
    const panel = runUi.panel(page);
    await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', progressText(1, 2));
    await expect(runUi.favorite(panel)).toBeVisible();
    await expect(runUi.retryToggle(panel)).toHaveCount(0);

    await runUi.option(panel, optionText(q(s, 1), 0)).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await expect(runUi.retryToggle(panel)).toHaveAttribute('data-state', 'off');
    await runUi.retryToggle(panel).click();
    await expect(runUi.retryToggle(panel)).toHaveAttribute('data-state', 'on');
    await expect
      .poll(async () => (await overviewItem(s.owner, s.workspaceId, q(s, 1).id)).needs_retry)
      .toBe(true);

    // The next question is still unanswered: no toggle.
    await runUi.next(panel).click();
    await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', progressText(2, 2));
    await expect(runUi.favorite(panel)).toBeVisible();
    await expect(runUi.retryToggle(panel)).toHaveCount(0);
  },
);

test(
  'RETRY-01-AC04 an existing retry flag on an unanswered question still shows in the Heatmap and filter but has no toggle until a correct answer',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'retry01-ac04', 2);
    const question = q(s, 1);
    // A flag from before the rule: set directly in the database (the API now refuses it).
    seedOwnerStudyState(s.owner.user.id, s.workspaceId, question.id);
    expect(await overviewItem(s.owner, s.workspaceId, question.id)).toMatchObject({
      needs_retry: true,
      status: 'retry',
      last_graded_result: null,
    });
    const filtered = await s.owner.api.ok<{ items: { question_id: string }[] }>(
      'GET',
      `/workspaces/${s.workspaceId}/questions/overview?retry=true`,
    );
    expect(filtered.items.map((i) => i.question_id)).toEqual([question.id]);

    await signInAs(page, s.owner.user);
    await page.goto(overviewPath(s.workspaceId));
    await expect(overviewUi.dot(page, 1)).toHaveAttribute('data-status', 'retry');
    const panel = await openPanel(page, 1);
    await expect(panelUi.favoriteOff(panel)).toBeVisible();
    await expect(panelUi.retryOn(panel)).toHaveCount(0);
    await expect(panelUi.retryOff(panel)).toHaveCount(0);

    await answer(panel, question, true);
    await expect(panelUi.retryOff(panel)).toHaveAttribute('data-state', 'on');
    await panelUi.retryOff(panel).click();
    await expect(panelUi.retryOn(panel)).toHaveAttribute('data-state', 'off');
  },
);
