// UX12-RESULTTABLE — the results step's table (docs/screens/ux12-result-table.md).
import type { Locator, Page } from '@playwright/test';
import { createMockExam, createNumberedQuestions } from '../fixtures/mock-exams.ts';
import { createPracticeRun, practiceRunPath, runUi } from '../fixtures/practice-runs.ts';
import {
  createQuestion,
  expect,
  numberedMcq,
  RESULT_TEXT,
  signInAs,
  test,
  type E2EFixtures,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const BANK_RUN = { source: 'bank', range: { all: true }, random_order: false } as const;
const NOT_TRANSPARENT = /^(?!rgba\(0, 0, 0, 0\)|transparent)/;

async function seed(
  workspaceFactory: E2EFixtures['workspaceFactory'],
  label: string,
  count: number,
): Promise<{ owner: Member; workspaceId: string; questions: Question[]; tag: string }> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const tag = `${label}-${Date.now()}`;
  const questions: Question[] = [];
  for (let n = 1; n <= count; n += 1) {
    questions.push(await createQuestion(owner, ws.id, numberedMcq(tag, n, 0)));
  }
  return { owner, workspaceId: ws.id, questions, tag };
}

function optionText(question: Question, index: number): string {
  const text = question.revision.options[index]?.text;
  if (!text) throw new Error('no option');
  return text;
}

async function answer(panel: Locator, text: string, result: RegExp): Promise<void> {
  await runUi.option(panel, text).check();
  await runUi.submit(panel).click();
  await expect(runUi.result(panel)).toContainText(result);
}

async function openResults(page: Page, workspaceId: string, runId: string): Promise<Locator> {
  await page.goto(`${practiceRunPath(workspaceId, runId)}&view=results`);
  const panel = runUi.panel(page);
  await expect(runUi.restart(panel)).toBeVisible();
  return panel;
}

/** A correct first position, an incorrect second one, and the rest skipped. */
async function solveTwo(page: Page, s: Awaited<ReturnType<typeof seed>>): Promise<Locator> {
  const [first, second] = s.questions as [Question, Question];
  const run = await createPracticeRun(s.owner, s.workspaceId, BANK_RUN);
  await signInAs(page, s.owner.user);
  await page.goto(practiceRunPath(s.workspaceId, run.id, 1));
  const panel = runUi.panel(page);
  await answer(panel, optionText(first, 0), RESULT_TEXT.correct);
  await runUi.next(panel).click();
  await answer(panel, optionText(second, 1), RESULT_TEXT.incorrect);
  return openResults(page, s.workspaceId, run.id);
}

const background = (cell: Locator) =>
  cell.evaluate((el: HTMLElement) => getComputedStyle(el).backgroundColor);

const backgrounds = async (row: Locator) => [
  await background(row.getByRole('rowheader')),
  await background(row.getByRole('cell')),
];

/** Moves the real pointer over `target`: the column's button lies above both of its cells. */
async function pointAt(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

test(
  'UX12-RESULTTABLE-AC01 a table of numbers and results replaces the list of stems',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-table-shape', 3);
    const panel = await solveTwo(page, s);

    await expect(
      runUi.summary(panel, { correct: 1, incorrect: 1, pending: 0, skipped: 1 }),
    ).toBeVisible();
    const table = runUi.resultList(panel).getByRole('table');
    await expect(table).toHaveCount(1);
    await expect(table).toHaveAccessibleName(/장 없음/);
    await expect(table.getByRole('rowheader')).toHaveText(['1번', '2번', '3번']);
    await expect(table.getByRole('cell')).toHaveCount(3);
    await expect(panel.getByText(new RegExp(`${s.tag}.*문제`))).toHaveCount(0);

    // Number above result, columns side by side.
    const firstRow = runUi.resultRows(panel).first();
    const number = await firstRow.getByRole('rowheader').boundingBox();
    const result = await firstRow.getByRole('cell').boundingBox();
    const next = await runUi.resultRows(panel).nth(1).boundingBox();
    expect(result?.y).toBeGreaterThan(number?.y ?? Infinity);
    expect(next?.x).toBeGreaterThan(number?.x ?? Infinity);
  },
);

test(
  'UX12-RESULTTABLE-AC02 O, X, 대기 and – name each column in words',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-table-marks', 3);
    const essay = await createQuestion(s.owner, s.workspaceId, {
      question_type: 'ESSAY',
      stem: `${s.tag} 서술: 물의 순환을 쓰시오.`,
      question_number: 4,
    });
    expect(essay.id).toBeTruthy();
    const run = await createPracticeRun(s.owner, s.workspaceId, BANK_RUN);
    await signInAs(page, s.owner.user);
    await page.goto(practiceRunPath(s.workspaceId, run.id, 1));
    const solving = runUi.panel(page);
    const [first, second] = s.questions as [Question, Question];
    await answer(solving, optionText(first, 0), RESULT_TEXT.correct);
    await runUi.next(solving).click();
    await answer(solving, optionText(second, 1), RESULT_TEXT.incorrect);
    await page.goto(practiceRunPath(s.workspaceId, run.id, 4));
    await runUi.answerText(solving).fill('답');
    await runUi.submit(solving).click();
    await expect(runUi.result(solving)).toContainText(RESULT_TEXT.pending);

    const panel = await openResults(page, s.workspaceId, run.id);
    await expect(
      runUi.summary(panel, { correct: 1, incorrect: 1, pending: 1, skipped: 1 }),
    ).toBeVisible();
    const rows = runUi.resultRows(panel);
    await expect(rows.nth(0).getByRole('cell', { name: '맞음' })).toHaveText('O');
    await expect(rows.nth(1).getByRole('cell', { name: '틀림' })).toHaveText('X');
    await expect(rows.nth(2).getByRole('cell', { name: '건너뜀' })).toHaveText('–');
    await expect(rows.nth(3).getByRole('cell', { name: '채점 대기' })).toHaveText('대기');
    await expect(rows.nth(0).getByRole('button')).toHaveAccessibleName('1번 맞음, 문제로 이동');
    await expect(rows.nth(1).getByRole('button')).toHaveAccessibleName('2번 틀림, 문제로 이동');
    await expect(rows.nth(2).getByRole('button')).toHaveAccessibleName('3번 건너뜀, 문제로 이동');
    await expect(rows.nth(3).getByRole('button')).toHaveAccessibleName(
      '4번 채점 대기, 문제로 이동',
    );
  },
);

test(
  'UX12-RESULTTABLE-AC03 hover and focus change the two cells of one column together',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-table-hover', 3);
    const panel = await solveTwo(page, s);
    const rows = runUi.resultRows(panel);
    const [, target, other] = [rows.nth(0), rows.nth(1), rows.nth(2)];
    const resting = await backgrounds(target);
    const otherResting = await backgrounds(other);

    await pointAt(page, target.getByRole('cell'));
    await expect.poll(() => backgrounds(target)).not.toEqual(resting);
    const hovered = await backgrounds(target);
    expect(hovered[0]).toMatch(NOT_TRANSPARENT);
    expect(hovered[1]).toBe(hovered[0]);
    expect(await backgrounds(other)).toEqual(otherResting);
    await page.mouse.move(0, 0);
    await expect.poll(() => backgrounds(target)).toEqual(resting);

    // From the keyboard, the same two cells.
    await rows.nth(0).getByRole('button').focus();
    await page.keyboard.press('Tab');
    await expect(target.getByRole('button')).toBeFocused();
    await expect.poll(() => backgrounds(target)).toEqual(hovered);
    expect(await backgrounds(other)).toEqual(otherResting);

    await pointAt(page, target.getByRole('cell'));
    await page.mouse.down();
    await page.mouse.up();
    await expect(page).toHaveURL(/[?&]i=2(&|$)/);
  },
);

test(
  'UX12-RESULTTABLE-AC04 a column opens its position read-only and back returns to the table',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-table-open', 3);
    const panel = await solveTwo(page, s);

    await runUi.resultRows(panel).nth(1).getByRole('button').click();
    await expect(page).toHaveURL(/[?&]i=2(&|$)/);
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.incorrect);
    await expect(runUi.submit(panel)).toHaveCount(0);

    await page.goBack();
    await expect(runUi.resultRows(panel)).toHaveCount(3);

    await runUi.resultRows(panel).first().getByRole('button').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/[?&]i=1(&|$)/);
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
  },
);

test(
  'UX12-RESULTTABLE-AC05 many columns wrap at phone width; 불가 and mock labels stay readable',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-table-wrap', 12);
    const [, removed] = s.questions as [Question, Question];
    const run = await createPracticeRun(s.owner, s.workspaceId, BANK_RUN);
    await s.owner.api.ok('DELETE', `/questions/${removed.id}`, undefined, [204]);
    await signInAs(page, s.owner.user);
    await page.setViewportSize({ width: 375, height: 740 });
    const panel = await openResults(page, s.workspaceId, run.id);

    const rows = runUi.resultRows(panel);
    await expect(rows).toHaveCount(12);
    const tops = new Set<number>();
    for (const row of await rows.all()) tops.add((await row.boundingBox())?.y ?? -1);
    expect(tops.size).toBeGreaterThan(1);
    expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);

    await expect(
      rows.nth(1).getByRole('cell', { name: /더 이상 풀 수 없는 문제/ }),
    ).toHaveText('불가');
    await expect(panel.getByText('불가: 더 이상 풀 수 없는 문제')).toBeVisible();
    await rows.nth(1).getByRole('button').click();
    await expect(page).toHaveURL(/[?&]i=2(&|$)/);
    await expect(runUi.unavailable(panel)).toBeVisible();

    // A mock run: the same table, numbered by position.
    const mockOwner = await workspaceFactory.member('ux12-table-mock');
    const workspace = await workspaceFactory.create(mockOwner);
    await createNumberedQuestions(mockOwner, workspace.id, 'ux12-table-mock', 2);
    const exam = await createMockExam(mockOwner, workspace.id, '표 시험', {
      variation_types: ['OPTION_SHUFFLE'],
      question_count: 2,
    });
    const mockRun = await createPracticeRun(mockOwner, workspace.id, {
      source: 'mock',
      mock_exam_id: exam.id,
      range: { all: true },
      random_order: false,
    });
    await signInAs(page, mockOwner.user);
    const mockPanel = await openResults(page, workspace.id, mockRun.id);
    await expect(runUi.resultList(mockPanel).getByRole('rowheader')).toHaveText([
      '문제 1',
      '문제 2',
    ]);
  },
);
