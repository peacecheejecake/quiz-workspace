// UX12-STEMTABLE (docs/screens/ux12-stemtable.md): a merged cell in a stem shows as one cell and
// the question editor edits the table as a table. The editing model, GFM regeneration and
// fallbacks live in Vitest; the copy paths in tests/integration and pgTAP.
import type { Locator, Page } from '@playwright/test';
import {
  choosePanelManage,
  createQuestion,
  expect,
  getQuestion,
  mcqInput,
  overviewPath,
  questionFormUi,
  signInAs,
  test,
  type Member,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const GFM = [
  '| 구분 | 구분 | 값 |',
  '| --- | --- | --- |',
  '| A | x | 1 |',
  '| A | y | 2 |',
  '| A | z | 3 |',
].join('\n');
const CELLS = {
  rows: [
    ['구분', '구분', '값'],
    ['A', 'x', '1'],
    ['A', 'y', '2'],
    ['A', 'z', '3'],
  ],
  header_rows: 1,
  spans: [
    { row: 0, col: 0, row_span: 1, col_span: 2 },
    { row: 1, col: 0, row_span: 3, col_span: 1 },
  ],
};

const questionPanel = (page: Page): Locator =>
  page.getByRole('dialog', { name: /번 문제|번호 없음|question \d|no number/i });

async function openPanel(page: Page, workspaceId: string, questionId: string): Promise<Locator> {
  await page.goto(overviewPath(workspaceId, questionId));
  const panel = questionPanel(page);
  await expect(panel).toBeVisible();
  return panel;
}

async function seed(member: Member, workspaceId: string): Promise<string> {
  const input = mcqInput(`표를 보고 고르시오.\n\n${GFM}`, ['가', '나']);
  const question = await createQuestion(member, workspaceId, { ...input, stem_tables: [CELLS] });
  return question.id;
}

test('UX12-STEMTABLE-AC01 a merged cell shows once and the editor keeps it through table edits', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('stem-table');
  const workspace = await workspaceFactory.create(owner);
  const id = await seed(owner, workspace.id);
  await signInAs(page, owner.user);
  await page.setViewportSize({ width: 375, height: 812 });

  const panel = await openPanel(page, workspace.id, id);
  await expect(panel.getByRole('cell', { name: 'A', exact: true })).toHaveCount(1);
  await expect(panel.getByRole('cell', { name: 'A', exact: true })).toHaveAttribute('rowspan', '3');
  await expect(panel.getByRole('columnheader', { name: '구분' })).toHaveAttribute('colspan', '2');

  await choosePanelManage(page, panel, 'edit');
  const form = questionFormUi.form(page);
  await expect(form).toBeVisible();
  const region = form.getByRole('region', { name: /표 1 편집/ });
  await expect(region).toBeVisible();
  const pageWidths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(pageWidths.scroll).toBeLessThanOrEqual(pageWidths.client);
  await expect(region).toHaveCSS('overflow-x', 'auto');

  await form.getByRole('textbox', { name: '표 1 2–4행 1열 병합' }).fill('B');

  // The row crossing the merged cell goes from its menu, by keyboard only.
  await form.getByRole('button', { name: '표 1 3행 메뉴' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: /이 행 삭제/ }).focus();
  await page.keyboard.press('Enter');

  await form.getByRole('button', { name: '표 1 3열 메뉴' }).click();
  await page.getByRole('menuitem', { name: /오른쪽에 열 추가/ }).click();

  await questionFormUi.save(form).click();
  await expect(form).toBeHidden();

  await expect.poll(async () => (await getQuestion(owner, id)).revision.version).toBe(2);
  const { revision } = await getQuestion(owner, id);
  expect(revision.stem).toBe(
    [
      '표를 보고 고르시오.',
      '',
      '| 구분 | 구분 | 값 |  |',
      '| --- | --- | --- | --- |',
      '| B | x | 1 |  |',
      '| B | z | 3 |  |',
    ].join('\n'),
  );
  expect(revision.stem_tables?.[0]?.spans).toEqual([
    { row: 0, col: 0, row_span: 1, col_span: 2 },
    { row: 1, col: 0, row_span: 2, col_span: 1 },
  ]);

  const reopened = await openPanel(page, workspace.id, id);
  await expect(reopened.getByRole('cell', { name: 'B', exact: true })).toHaveAttribute(
    'rowspan',
    '2',
  );
  await expect(reopened.getByRole('cell', { name: 'A', exact: true })).toHaveCount(0);
});
