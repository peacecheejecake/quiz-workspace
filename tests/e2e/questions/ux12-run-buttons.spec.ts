// UX12-RUNBAR — the run's footer matches the Heatmap path (docs/screens/ux12-run-buttons.md).
import type { Locator } from '@playwright/test';
import { createPracticeRun, practiceRunPath, runUi } from '../fixtures/practice-runs.ts';
import {
  createQuestion,
  expect,
  numberedMcq,
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

const AGAIN = /^다시 풀기$|^solve again$/i;
const REASON = /제출하고 채점이 끝나면/;
const OLD_NAMES = /^(이전|다음|건너뛰기|previous|next|skip)$/i;
const NAV = /문제 이동|question navigation/i;
const BANK_RUN = { source: 'bank', range: { all: true }, random_order: false } as const;

async function seed(
  workspaceFactory: E2EFixtures['workspaceFactory'],
  label: string,
  count: number,
): Promise<{ owner: Member; workspaceId: string; questions: Question[] }> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const questions: Question[] = [];
  for (let n = 1; n <= count; n += 1) {
    questions.push(await createQuestion(owner, ws.id, numberedMcq(`${label}-${Date.now()}`, n, 0)));
  }
  return { owner, workspaceId: ws.id, questions };
}

function firstOption(question: Question): string {
  const text = question.revision.options[0]?.text;
  if (!text) throw new Error('no option');
  return text;
}

/** The look of an arrow: what the two paths must share. */
const arrowLook = (button: Locator) =>
  button.evaluate((el: HTMLElement) => {
    const { width, height } = el.getBoundingClientRect();
    return { name: el.getAttribute('aria-label'), variant: el.dataset.variant, width, height };
  });

/** The buttons of the panel's footer in DOM order: the row around the 문제 이동 area. */
const footerNames = (panel: Locator) =>
  panel
    .getByRole('navigation', { name: NAV })
    .locator('xpath=..')
    .getByRole('button')
    .evaluateAll((buttons) =>
      buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim()),
    );

test(
  'UX12-RUNBAR-AC01 the run has the footer of a question opened from the Heatmap',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-runbar-footer', 3);
    const [first] = s.questions as [Question];
    await signInAs(page, s.owner.user);

    await page.goto(overviewPath(s.workspaceId));
    await overviewUi.dot(page, 2).click();
    const single = panelUi.numbered(page, 2);
    await expect(panelUi.submit(single)).toBeVisible();
    const singleNav = single.getByRole('navigation', { name: NAV });
    const heatmapPrevious = await arrowLook(runUi.previous(singleNav));
    const heatmapNext = await arrowLook(runUi.next(singleNav));
    const heatmapFooter = await footerNames(single);

    const run = await createPracticeRun(s.owner, s.workspaceId, BANK_RUN);
    await page.goto(practiceRunPath(s.workspaceId, run.id, 2));
    const panel = runUi.panel(page);
    await expect(runUi.submit(panel)).toBeVisible();
    const nav = panel.getByRole('navigation', { name: NAV });
    expect(await arrowLook(runUi.previous(nav))).toEqual(heatmapPrevious);
    expect(await arrowLook(runUi.next(nav))).toEqual(heatmapNext);
    expect(await footerNames(panel)).toEqual(heatmapFooter);
    await expect(panel.getByRole('button', { name: OLD_NAMES })).toHaveCount(0);

    // No emphasis after a submission either.
    await page.goto(practiceRunPath(s.workspaceId, run.id, 1));
    await runUi.option(panel, firstOption(first)).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
    expect(await arrowLook(runUi.next(nav))).toEqual(heatmapNext);
  },
);

test(
  'UX12-RUNBAR-AC02 the arrows stay disabled at the ends; 결과 보기 joins them on the last position',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-runbar-ends', 2);
    const [, second] = s.questions as [Question, Question];
    const run = await createPracticeRun(s.owner, s.workspaceId, BANK_RUN);
    await signInAs(page, s.owner.user);
    await page.goto(practiceRunPath(s.workspaceId, run.id, 1));
    const panel = runUi.panel(page);
    await expect(runUi.submit(panel)).toBeVisible();
    await expect(runUi.previous(panel)).toHaveAttribute('aria-disabled', 'true');
    await expect(runUi.next(panel)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(runUi.showResults(panel)).toHaveCount(0);
    const { x } = (await runUi.next(panel).boundingBox()) ?? { x: 0 };

    await runUi.next(panel).click();
    await expect(runUi.option(panel, firstOption(second))).toBeVisible();
    await expect(runUi.previous(panel)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(runUi.next(panel)).toHaveAttribute('aria-disabled', 'true');
    expect((await runUi.next(panel).boundingBox())?.x).toBe(x);
    await expect(runUi.showResults(panel)).toHaveAttribute('data-variant', 'secondary');

    await runUi.option(panel, firstOption(second)).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await expect(runUi.showResults(panel)).toHaveAttribute('data-variant', 'primary');
    await expect(runUi.next(panel)).toHaveAttribute('aria-disabled', 'true');
  },
);

test(
  'UX12-RUNBAR-AC03 다음 문제 on an unanswered position counts it as skipped',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-runbar-skip', 2);
    const [, second] = s.questions as [Question, Question];
    const run = await createPracticeRun(s.owner, s.workspaceId, BANK_RUN);
    await signInAs(page, s.owner.user);
    await page.goto(practiceRunPath(s.workspaceId, run.id, 1));
    const panel = runUi.panel(page);
    await expect(runUi.submit(panel)).toBeVisible();
    await expect(panel.getByRole('button', { name: /^(건너뛰기|skip)$/i })).toHaveCount(0);

    await runUi.next(panel).click();
    await expect(runUi.option(panel, firstOption(second))).toBeVisible();
    await runUi.option(panel, firstOption(second)).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await runUi.showResults(panel).click();
    await expect(runUi.restart(panel)).toBeVisible();
    await expect(panel).toContainText(/맞음 1 · 틀림 0 · 채점 대기 0 · 건너뜀 1/);
  },
);

test(
  'UX12-RUNBAR-AC04 the run footer 다시 풀기 waits for a result, as on the Heatmap path',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-runbar-again', 2);
    const [first] = s.questions as [Question, Question];
    const run = await createPracticeRun(s.owner, s.workspaceId, BANK_RUN);
    await signInAs(page, s.owner.user);
    await page.goto(practiceRunPath(s.workspaceId, run.id, 1));
    const panel = runUi.panel(page);
    await expect(runUi.submit(panel)).toBeVisible();
    const again = panel.getByRole('button', { name: AGAIN });
    await expect(again).toHaveAttribute('aria-disabled', 'true');
    await expect(again).toHaveAccessibleDescription(REASON);
    await again.dispatchEvent('click');
    await expect(page.getByRole('dialog', { name: '문제 다시 풀기' })).toHaveCount(0);

    await runUi.option(panel, firstOption(first)).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await expect(again).not.toHaveAttribute('aria-disabled', 'true');

    // A position skipped in a finished run has no other way to be solved.
    await runUi.next(panel).click();
    await runUi.showResults(panel).click();
    await expect(runUi.restart(panel)).toBeVisible();
    await page.goto(practiceRunPath(s.workspaceId, run.id, 2));
    await expect(again).toBeVisible();
    await expect(again).not.toHaveAttribute('aria-disabled', 'true');
    await again.click();
    await expect(page.getByRole('dialog', { name: '문제 다시 풀기' })).toBeVisible();
  },
);
