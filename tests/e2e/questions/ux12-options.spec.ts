import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import {
  createQuestion,
  expect,
  homePath,
  numberedMcq,
  optionRowBox,
  overviewUi,
  panelUi,
  signInAs,
  test,
  tokenColor,
  type E2EFixtures,
  type Member,
  type QuestionInput,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const REGULAR = '400';
// Long enough to wrap: the hover must not make the row taller.
const LONG_OPTION = Array.from({ length: 70 }, (_, i) => `word${i % 7}`).join(' ');

interface Seeded {
  readonly owner: Member;
  readonly workspaceId: string;
}

async function seed(
  workspaceFactory: E2EFixtures['workspaceFactory'],
  label: string,
  inputs: readonly QuestionInput[],
): Promise<Seeded> {
  const owner = await workspaceFactory.member(label);
  const workspace = await workspaceFactory.create(owner);
  for (const [i, input] of inputs.entries()) {
    await createQuestion(owner, workspace.id, { question_number: i + 1, ...input });
  }
  return { owner, workspaceId: workspace.id };
}

async function openOverview(page: Page, s: Seeded): Promise<void> {
  await signInAs(page, s.owner.user);
  await page.goto(homePath(s.workspaceId));
  await expect(overviewUi.heatmap(page)).toBeVisible();
}

async function openPanel(page: Page, n: number): Promise<Locator> {
  await overviewUi.dot(page, n).click();
  const panel = panelUi.numbered(page, n);
  await expect(panel).toBeVisible();
  return panel;
}

const rowOf = (option: Locator) => option.locator('xpath=..');
const labelOf = (option: Locator) => rowOf(option).locator('label');
const moveAway = (page: Page) => page.mouse.move(0, 0);

async function expectHidden(target: Locator): Promise<void> {
  const box = await target.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(1);
  expect(box?.height).toBeLessThanOrEqual(1);
}

async function rowHeight(option: Locator): Promise<number> {
  return rowOf(option).evaluate((row) => row.getBoundingClientRect().height);
}

async function rowBoxes(panel: Locator) {
  const options = await panelUi.options(panel).all();
  return Promise.all(options.map((option) => optionRowBox(option)));
}

test(
  'UX12-OPTIONS-AC01 a hovered option row darkens its control and thickens its border to 2px, without moving or bolding',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = `ux12-opt1-${randomUUID().slice(0, 8)}`;
    const single = numberedMcq(label, 1);
    const options = (single.options ?? []).map((o, i) =>
      i === 1 ? { ...o, text: LONG_OPTION } : o,
    );
    const s = await seed(workspaceFactory, label, [
      { ...single, options },
      { ...numberedMcq(label, 2), is_multi_answer: true },
    ]);
    await openOverview(page, s);
    const rest = await tokenColor(page, 'color-option-control');
    const hover = await tokenColor(page, 'color-option-control-hover');
    expect(rest).not.toBe(hover);

    const first = `${label}-1 보기 가`;
    const rows: readonly (readonly [number, readonly string[]])[] = [
      [1, [first, LONG_OPTION]],
      [2, [`${label}-2 보기 가`]],
    ];
    for (const [n, texts] of rows) {
      const panel = await openPanel(page, n);
      for (const text of texts) {
        const option = panelUi.option(panel, text);
        await expect(option).toHaveCSS('border-top-color', rest);
        await expect(option).toHaveCSS('border-top-width', '1px');
        await expect(labelOf(option)).toHaveCSS('font-weight', REGULAR);
        const height = await rowHeight(option);
        const control = await option.boundingBox();

        await rowOf(option).hover();
        await expect(option).toHaveCSS('border-top-color', hover);
        await expect(option).toHaveCSS('border-top-width', '2px');
        await expect(labelOf(option)).toHaveCSS('font-weight', REGULAR);
        expect(await rowHeight(option)).toBeCloseTo(height, 1);
        expect(await option.boundingBox()).toEqual(control);

        await moveAway(page);
        await expect(option).toHaveCSS('border-top-color', rest);
        await expect(option).toHaveCSS('border-top-width', '1px');
      }
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
    }
  },
);

test(
  'UX12-OPTIONS-AC02 a disabled option row does not react to hover',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = `ux12-opt2-${randomUUID().slice(0, 8)}`;
    const s = await seed(workspaceFactory, label, [numberedMcq(label, 1)]);
    await openOverview(page, s);
    const rest = await tokenColor(page, 'color-option-control');
    const panel = await openPanel(page, 1);
    await panelUi.option(panel, `${label}-1 보기 가`).check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(/정답입니다/);

    const other = panelUi.option(panel, `${label}-1 보기 나`);
    await expect(other).toBeDisabled();
    await rowOf(other).hover();
    await expect(other).toHaveCSS('border-top-color', rest);
    await expect(labelOf(other)).toHaveCSS('font-weight', REGULAR);
  },
);

test(
  'UX12-OPTIONS-AC03 an MCQ result shows check and X icons and keeps its wording for assistive tech only',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = `ux12-opt3-${randomUUID().slice(0, 8)}`;
    const s = await seed(workspaceFactory, label, [numberedMcq(label, 1)]);
    const [a, b] = [`${label}-1 보기 가`, `${label}-1 보기 나`];
    await openOverview(page, s);
    const panel = await openPanel(page, 1);
    const icon = (text: string, mark: 'correct' | 'wrong') =>
      rowOf(panelUi.option(panel, text)).locator(`[data-option-mark="${mark}"] svg`);

    // Wrong answer first: both icons, on the rows they belong to.
    await panelUi.option(panel, b).check();
    const before = await rowBoxes(panel);
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toHaveText('오답입니다.');
    await expectHidden(panelUi.result(panel));
    await expect(icon(b, 'wrong')).toBeVisible();
    await expect(icon(a, 'correct')).toBeVisible();
    await expect(panel.locator('[data-option-mark]')).toHaveCount(2);
    await expect(panelUi.option(panel, b)).toHaveAccessibleDescription('내 선택');
    await expect(panelUi.option(panel, a)).toHaveAccessibleDescription('정답');
    await expectHidden(panel.getByText('내 선택', { exact: true }));
    await expectHidden(panel.getByText('정답', { exact: true }));
    expect(await rowBoxes(panel)).toEqual(before);

    // A correct answer: one check, on the chosen row.
    await panel.getByRole('button', { name: /^다시 풀기$/ }).click();
    await panelUi.option(panel, a).check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toHaveText('정답입니다.');
    await expectHidden(panelUi.result(panel));
    await expect(icon(a, 'correct')).toBeVisible();
    await expect(panel.locator('[data-option-mark]')).toHaveCount(1);
    await expect(panelUi.option(panel, a)).toHaveAccessibleDescription('정답 · 내 선택');
    await expectHidden(panel.getByText('정답 · 내 선택', { exact: true }));
  },
);

test(
  'UX12-OPTIONS-AC04 short answer and essay results keep their visible wording',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = `ux12-opt4-${randomUUID().slice(0, 8)}`;
    const s = await seed(workspaceFactory, label, [
      { question_type: 'SHORT_ANSWER', stem: `${label} 단답`, accepted_answers: ['증발'] },
      { question_type: 'ESSAY', stem: `${label} 서술`, rubric: '기준' },
    ]);
    await openOverview(page, s);

    let panel = await openPanel(page, 1);
    await panelUi.answerText(panel).fill('증발');
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toHaveText('정답입니다.');
    expect((await panelUi.result(panel).boundingBox())?.height).toBeGreaterThan(1);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    panel = await openPanel(page, 2);
    await panelUi.answerText(panel).fill('답안');
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(/채점 대기/);
    expect((await panelUi.result(panel).boundingBox())?.height).toBeGreaterThan(1);
    await panelUi.selfGradeCorrect(panel).click();
    await expect(panelUi.result(panel)).toContainText(/정답으로 채점/);
    expect((await panelUi.result(panel).boundingBox())?.height).toBeGreaterThan(1);
  },
);

test(
  'UX12-OPTIONS-AC05 favorite and retry toggles show their state by the icon alone, without a fill',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = `ux12-opt5-${randomUUID().slice(0, 8)}`;
    const s = await seed(workspaceFactory, label, [numberedMcq(label, 1)]);
    await openOverview(page, s);
    const hover = await tokenColor(page, 'color-state-hover');
    const panel = await openPanel(page, 1);
    await panelUi.option(panel, `${label}-1 보기 가`).check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(/정답입니다/);

    const toggles = [
      [panelUi.favoriteOn(panel), panelUi.favoriteOff(panel)],
      [panelUi.retryOn(panel), panelUi.retryOff(panel)],
    ] as const;
    for (const [off, on] of toggles) {
      const iconOff = await off.locator('svg').evaluate((svg) => svg.outerHTML);
      await off.click();
      await expect(on).toBeVisible();
      await moveAway(page);
      await expect(on).toHaveCSS('background-color', TRANSPARENT);
      expect(await on.locator('svg').evaluate((svg) => svg.outerHTML)).not.toBe(iconOff);
      await on.hover();
      await expect(on).toHaveCSS('background-color', hover);
      await moveAway(page);
    }
  },
);

test(
  'UX12-OPTIONS-AC06 an option keeps its line breaks',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = `ux12-opt6-${randomUUID().slice(0, 8)}`;
    const question = numberedMcq(label, 1);
    const options = (question.options ?? []).map((o, i) =>
      i === 1 ? { ...o, text: `${label} 첫 줄\n둘째 줄\n셋째 줄` } : o,
    );
    const s = await seed(workspaceFactory, label, [{ ...question, options }]);
    await openOverview(page, s);
    const panel = await openPanel(page, 1);
    const option = panelUi.options(panel).nth(1);
    const oneLine = await rowHeight(panelUi.options(panel).first());

    await expect(labelOf(option)).toContainText('둘째 줄');
    await expect(labelOf(option)).toHaveCSS('white-space', 'pre-wrap');
    expect(await rowHeight(option)).toBeGreaterThan(oneLine + 40);

    await panelUi.options(panel).first().check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(/정답입니다/);
    expect(await rowHeight(option)).toBeGreaterThan(oneLine + 40);
  },
);

test(
  'UX12-OPTIONS-AC07 a keyboard MCQ submission moves focus to the options with a visible ring',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = `ux12-opt7-${randomUUID().slice(0, 8)}`;
    const s = await seed(workspaceFactory, label, [numberedMcq(label, 1)]);
    await openOverview(page, s);
    const focusColor = await tokenColor(page, 'color-focus');
    const panel = await openPanel(page, 1);
    await panelUi.option(panel, `${label}-1 보기 나`).check();
    await panelUi.submit(panel).focus();
    await page.keyboard.press('Enter');

    await expect(panelUi.result(panel)).toHaveText('오답입니다.');
    await expectHidden(panelUi.result(panel));
    const region = panel.getByRole('group', { name: '오답입니다.' });
    await expect(region).toBeFocused();
    await expect(region).toHaveCSS('outline-style', 'solid');
    await expect(region).toHaveCSS('outline-width', '2px');
    await expect(region).toHaveCSS('outline-color', focusColor);
    await expect(region.getByRole('radio')).toHaveCount(4);
    const box = await region.boundingBox();
    expect(box?.height).toBeGreaterThan(100);
  },
);
