// UX12-PASSAGE2 (docs/screens/ux12-stem-items.md): `- 이름 : 값` items run together on one line.
import type { Locator, Page } from '@playwright/test';
import {
  createPracticeRun,
  createShuffleMockExam,
  practiceRunPath,
  runUi,
} from '../fixtures/practice-runs.ts';
import {
  createQuestion,
  detailUi,
  expect,
  getQuestion,
  mcqInput,
  overviewPath,
  overviewUi,
  PANEL_MANAGE_ITEMS,
  panelUi,
  signInAs,
  test,
  type E2EFixtures,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const LEAD = '다음 두 항목을 모두 더하면 합계는?';
const STEM = `${LEAD} - 가람 항목 : 10 , 20 - 누리 항목 : 30 , 40`;
const OPTIONS = ['10', '50', '100', '150'];
const ALL = { all: true } as const;

async function seed(workspaceFactory: E2EFixtures['workspaceFactory'], name: string, stem: string) {
  const owner = await workspaceFactory.member(name);
  const workspace = await workspaceFactory.create(owner);
  const question = await createQuestion(owner, workspace.id, {
    question_number: 1,
    ...mcqInput(stem, OPTIONS, 0),
  });
  return { owner, workspace, question };
}

async function openPanel(page: Page, workspaceId: string) {
  await page.goto(overviewPath(workspaceId));
  await expect(overviewUi.heatmap(page)).toBeVisible();
  await overviewUi.dot(page, 1).click();
  const panel = panelUi.numbered(page, 1);
  await expect(panel).toBeVisible();
  // The stem first shows as the loading preview, and the loaded body replaces those elements.
  await expect(panelUi.options(panel).first()).toBeVisible();
  return panel;
}

const items = (scope: Locator) => scope.getByRole('list', { name: /^(제시 항목|stem items)$/i });

/** The item box ends well above the first option. */
async function expectApart(scope: Locator, options: Locator) {
  await expect(items(scope)).toBeVisible();
  await expect(options).toBeVisible();
  const list = await items(scope).boundingBox();
  const area = await options.boundingBox();
  if (!list || !area) throw new Error('the item box and the options must be laid out');
  expect(area.y).toBeGreaterThanOrEqual(list.y + list.height + 8);
}

test(
  'UX12-PASSAGE2-AC01 items on one line get a line each in the item box',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspace } = await seed(workspaceFactory, 'ux12-passage2-1', STEM);
    await signInAs(page, owner.user);
    const panel = await openPanel(page, workspace.id);

    await expect(panel.getByText(LEAD)).toHaveJSProperty('tagName', 'P');
    const rows = items(panel).getByRole('listitem');
    await expect(rows).toHaveText([/^-\s*가람 항목 : 10 , 20$/, /^-\s*누리 항목 : 30 , 40$/]);
    const first = await rows.nth(0).boundingBox();
    const second = await rows.nth(1).boundingBox();
    if (!first || !second) throw new Error('item lines must be laid out');
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
  },
);

for (const [label, stem] of [
  ['a word range', '근무 기간은 A - B 이고 비율은 1 - 2 이다.'],
  ['a date and a compound word', '시작은 2023-01 이고 형식은 객관-주관 혼합이다.'],
  ['a lone dash in prose', '다음은 무엇인가? - 가람 항목'],
  ['dashes without a name and value', '합계는? - 가람 항목 - 누리 항목'],
] as const) {
  test(
    `UX12-PASSAGE2-AC02 ${label} stays in the paragraph`,
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const { owner, workspace } = await seed(workspaceFactory, 'ux12-passage2-2', stem);
      await signInAs(page, owner.user);
      const panel = await openPanel(page, workspace.id);
      await expect(panel.getByText(stem)).toHaveJSProperty('tagName', 'P');
      await expect(items(panel)).toHaveCount(0);
    },
  );
}

test(
  'UX12-PASSAGE2-AC03 the stored stem stays on one line',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspace, question } = await seed(workspaceFactory, 'ux12-passage2-3', STEM);
    await signInAs(page, owner.user);
    const panel = await openPanel(page, workspace.id);
    await expect(items(panel).getByRole('listitem')).toHaveCount(2);
    expect((await getQuestion(owner, question.id)).revision.stem).toBe(STEM);
  },
);

test(
  'UX12-PASSAGE2-AC04 the item box stands apart from the options on every screen',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspace, question } = await seed(workspaceFactory, 'ux12-passage2-4', STEM);
    await signInAs(page, owner.user);

    const panel = await openPanel(page, workspace.id);
    await expectApart(panel, panelUi.options(panel).first());
    await panelUi.manage(panel).or(panelUi.info(panel)).click();
    await page
      .getByRole('menu')
      .getByRole('menuitem', { name: PANEL_MANAGE_ITEMS.answers })
      .click();
    const detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    await expectApart(detail, detail.getByRole('list', { name: /^(보기|options)$/i }));

    const run = await createPracticeRun(owner, workspace.id, {
      source: 'bank',
      range: ALL,
      random_order: false,
    });
    await page.goto(practiceRunPath(workspace.id, run.id, 1));
    const runPanel = runUi.panel(page);
    await expectApart(runPanel, panelUi.options(runPanel).first());

    const exam = await createShuffleMockExam(owner, workspace.id, '항목 시험', [question.id], 1);
    const mockRun = await createPracticeRun(owner, workspace.id, {
      source: 'mock',
      mock_exam_id: exam.id,
      range: ALL,
      random_order: false,
    });
    await page.goto(practiceRunPath(workspace.id, mockRun.id, 1));
    const mockPanel = runUi.panel(page);
    await expectApart(mockPanel, panelUi.options(mockPanel).first());
  },
);

test(
  'UX12-PASSAGE2-AC05 the same list under <보기> is one titled box',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const stem = `${LEAD} <보기> - 가람 항목 : 10 - 누리 항목 : 30`;
    const { owner, workspace } = await seed(workspaceFactory, 'ux12-passage2-5', stem);
    await signInAs(page, owner.user);
    const panel = await openPanel(page, workspace.id);
    const box = panel.getByRole('region', { name: '<보기>' });
    await expect(box.getByRole('heading', { name: '<보기>' })).toBeVisible();
    await expect(box.getByRole('listitem')).toHaveText([/가람 항목 : 10$/, /누리 항목 : 30$/]);
  },
);
