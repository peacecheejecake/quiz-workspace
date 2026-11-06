// UX12-VIEW — controls of the question viewers (docs/screens/ux12-viewer.md).
import type { Locator, Page } from '@playwright/test';
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
  startPractice,
  submitPractice,
  test,
  type E2EFixtures,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const AGAIN = /^다시 풀기$|^solve again$/i;
const RESET = /^초기화$|^reset$/i;
const REASON = /제출하고 채점이 끝나면/;
const BANK_RUN = { source: 'bank', range: { all: true }, random_order: false } as const;
/** Taller than any test viewport: the panel body has to scroll. */
const LONG_STEM = Array.from({ length: 60 }, (_, i) => `지문 ${i + 1}번째 줄입니다.`).join('\n\n');

async function seed(
  workspaceFactory: E2EFixtures['workspaceFactory'],
  label: string,
  count: number,
): Promise<{ owner: Member; workspaceId: string; questions: Question[] }> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const questions: Question[] = [];
  for (let n = 1; n <= count; n += 1) {
    questions.push(
      await createQuestion(
        owner,
        ws.id,
        numberedMcq(`${label}-${Date.now()}`, n, 0, { stem: `${n}번 ${LONG_STEM}` }),
      ),
    );
  }
  return { owner, workspaceId: ws.id, questions };
}

function firstOption(question: Question): string {
  const text = question.revision.options[0]?.text;
  if (!text) throw new Error('no option');
  return text;
}

async function openPanel(page: Page, n: number): Promise<Locator> {
  await overviewUi.dot(page, n).click();
  const panel = panelUi.numbered(page, n);
  await expect(panel).toBeVisible();
  return panel;
}

const scrollTop = (panel: Locator) => panel.locator('.body').evaluate((el) => el.scrollTop);
const overflows = (panel: Locator) =>
  panel.locator('.body').evaluate((el) => el.scrollHeight > el.clientHeight + 100);
const scrollToEnd = (panel: Locator) =>
  panel.locator('.body').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });

/**
 * The loading state between two positions is short, and the browser clamps scrollTop to it. Keeps
 * the content tall across a move, so only a real reset brings the body back to the top.
 */
const keepTall = (panel: Locator) =>
  panel.locator('.body > div').evaluate((el) => {
    (el as HTMLElement).style.minHeight = '3000px';
  });

/** UX12-OPTIONS-AC07: an MCQ grade focuses the options, a group named by the hidden result. */
const gradedOptions = (panel: Locator) => panel.getByRole('group', { name: RESULT_TEXT.correct });

async function heightOf(locator: Locator): Promise<number | undefined> {
  return (await locator.boundingBox())?.height;
}

test(
  'UX12-VIEW-AC01 sequence moves by arrow buttons as tall as 제출',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-view-arrows', 2);
    const [first] = s.questions as [Question];
    const run = await createPracticeRun(s.owner, s.workspaceId, BANK_RUN);
    await signInAs(page, s.owner.user);
    await page.goto(practiceRunPath(s.workspaceId, run.id, 1));
    const panel = runUi.panel(page);
    await expect(runUi.option(panel, firstOption(first))).toBeVisible();

    const previous = runUi.previous(panel);
    await expect(previous).toHaveAttribute('aria-disabled', 'true');
    await expect(previous.locator('svg')).toBeVisible();
    await expect(previous).toHaveText('');
    const next = runUi.next(panel);
    await expect(next.locator('svg')).toBeVisible();
    await expect(next).toHaveText('');
    const height = await heightOf(runUi.submit(panel));
    expect(await heightOf(previous)).toBe(height);
    expect(await heightOf(next)).toBe(height);

    await next.click();
    await expect(runUi.showResults(panel)).toHaveText(/결과 보기|results/i);
    await expect(previous).not.toHaveAttribute('aria-disabled', 'true');
    expect(await heightOf(runUi.showResults(panel))).toBe(height);
  },
);

test(
  'UX12-VIEW-AC02 the practice footer 다시 풀기 has a background and a border',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-view-style', 1);
    const [question] = s.questions as [Question];
    const session = await startPractice(s.owner, question.id);
    await submitPractice(s.owner, session.id, {
      selected_option_ids: question.revision.correct_option_ids ?? [],
    });
    await signInAs(page, s.owner.user);
    await page.goto(overviewPath(s.workspaceId));
    const panel = await openPanel(page, 1);
    const again = panel.getByRole('button', { name: AGAIN });
    await expect(again).toBeEnabled();
    await expect(again).toHaveAttribute('data-variant', 'secondary');
    await expect(again).not.toHaveCSS('border-top-width', '0px');
    await expect(again).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  },
);

test(
  'UX12-VIEW-AC03 초기화 shows only when there is a result to reset',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-view-reset', 1);
    const [question] = s.questions as [Question];
    await signInAs(page, s.owner.user);
    await page.goto(overviewPath(s.workspaceId));
    const panel = await openPanel(page, 1);
    await expect(panelUi.submit(panel)).toBeVisible();
    await expect(panel.getByRole('button', { name: RESET })).toHaveCount(0);

    await panelUi.option(panel, firstOption(question)).check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await expect(panel.getByRole('button', { name: RESET })).toBeVisible();

    await panel.getByRole('button', { name: AGAIN }).click();
    await expect(panelUi.submit(panel)).toBeVisible();
    await expect(panel.getByRole('button', { name: RESET })).toBeVisible();
  },
);

test(
  'UX12-VIEW-AC04 the footer 다시 풀기 is always there, disabled with its reason until a result',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-view-again', 1);
    const [question] = s.questions as [Question];
    await signInAs(page, s.owner.user);
    await page.goto(overviewPath(s.workspaceId));
    const panel = await openPanel(page, 1);
    await expect(panelUi.submit(panel)).toBeVisible();
    const again = panel.getByRole('button', { name: AGAIN });
    await expect(again).toBeVisible();
    await expect(again).toHaveAttribute('aria-disabled', 'true');
    await expect(again).toHaveAccessibleDescription(REASON);
    await again.focus();
    await expect(page.getByRole('tooltip')).toContainText(REASON);
    // RETRY-01: the header toggle stays absent before a correct result.
    await expect(panelUi.retryOn(panel)).toHaveCount(0);
    // A press (a tap shows no tooltip) says why in a toast with nothing to act on, and changes nothing.
    await again.dispatchEvent('click');
    const toast = page
      .getByRole('region', { name: /알림 \(F8\)|notifications/i })
      .locator('li')
      .filter({ hasText: REASON });
    await expect(toast).toHaveCount(1);
    await expect(toast.getByRole('button')).toHaveCount(1);
    await expect(toast.getByRole('button')).toHaveAccessibleName(/닫기|close/i);
    await again.dispatchEvent('click');
    await expect(toast).toHaveCount(1);
    await expect(panelUi.submit(panel)).toBeVisible();

    await panelUi.option(panel, firstOption(question)).check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await expect(again).not.toHaveAttribute('aria-disabled', 'true');
    await again.click();
    await expect(panelUi.submit(panel)).toBeVisible();
    await expect(panelUi.option(panel, firstOption(question))).not.toBeChecked();
    await expect(again).toHaveAttribute('aria-disabled', 'true');
  },
);

test(
  'UX12-VIEW-AC05 reopening a submitted question starts at the top, a live submit focuses the result',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    const s = await seed(workspaceFactory, 'ux12-view-reopen', 2);
    const [first, second] = s.questions as [Question, Question];
    const session = await startPractice(s.owner, first.id);
    await submitPractice(s.owner, session.id, {
      selected_option_ids: first.revision.correct_option_ids ?? [],
    });
    await signInAs(page, s.owner.user);
    await page.goto(overviewPath(s.workspaceId));

    let panel = await openPanel(page, 1);
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    expect(await overflows(panel)).toBe(true);
    await expect(gradedOptions(panel)).not.toBeFocused();
    await expect(panelUi.result(panel)).not.toBeFocused();
    expect(await scrollTop(panel)).toBe(0);
    await panelUi.close(panel).click();
    await expect(panel).toBeHidden();

    panel = await openPanel(page, 2);
    await panelUi.option(panel, firstOption(second)).check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await expect(gradedOptions(panel)).toBeFocused();
    await expect.poll(() => scrollTop(panel)).toBeGreaterThan(0);
  },
);

test(
  'UX12-VIEW-AC06 moving to another sequence position starts at the top of the panel',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    const s = await seed(workspaceFactory, 'ux12-view-scroll', 2);
    const [first, second] = s.questions as [Question, Question];
    const run = await createPracticeRun(s.owner, s.workspaceId, BANK_RUN);
    await signInAs(page, s.owner.user);
    await page.goto(practiceRunPath(s.workspaceId, run.id, 1));
    const panel = runUi.panel(page);
    await expect(runUi.option(panel, firstOption(first))).toBeVisible();
    await keepTall(panel);
    expect(await scrollToEnd(panel)).toBeGreaterThan(0);

    await runUi.next(panel).click();
    await expect(runUi.option(panel, firstOption(second))).toBeVisible();
    expect(await overflows(panel)).toBe(true);
    expect(await scrollTop(panel)).toBe(0);

    expect(await scrollToEnd(panel)).toBeGreaterThan(0);
    await runUi.previous(panel).click();
    await expect(runUi.option(panel, firstOption(first))).toBeVisible();
    expect(await overflows(panel)).toBe(true);
    expect(await scrollTop(panel)).toBe(0);
  },
);
