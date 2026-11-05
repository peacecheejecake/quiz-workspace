import type { Locator, Page } from '@playwright/test';
import {
  createQuestion,
  expect,
  getQuestion,
  mcqInput,
  overviewPath,
  overviewUi,
  panelUi,
  signInAs,
  test,
  type E2EFixtures,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

function itemList(scope: Locator): Locator {
  return scope.getByRole('list', { name: /^(제시 항목|stem items)$/i });
}

async function ux11StemCase(
  page: Page,
  workspaceFactory: E2EFixtures['workspaceFactory'],
  index: number,
) {
  const { readFileSync } = await import('node:fs');
  const cases = JSON.parse(readFileSync('tests/fixtures/ux11-stem.json', 'utf8')) as {
    stem: string;
    options: string[];
  }[];
  const example = cases[index];
  if (!example) throw new Error('missing UX11 fixture');
  const owner = await workspaceFactory.member(`ux11-stem-${index}`);
  const workspace = await workspaceFactory.create(owner);
  const question = await createQuestion(owner, workspace.id, {
    question_number: 1,
    ...mcqInput(example.stem, example.options, 0),
  });
  await signInAs(page, owner.user);
  await page.goto(overviewPath(workspace.id));
  await expect(overviewUi.heatmap(page)).toBeVisible();
  await overviewUi.dot(page, 1).click();
  const panel = panelUi.numbered(page, 1);
  await expect(panel).toBeVisible();
  await expect(panelUi.options(panel)).toHaveCount(4);
  if (index === 2) {
    await expect(itemList(panel)).toHaveCount(0);
    const passage = panel.getByText(/카드사는 회원의 카드가 최종 이용일/);
    await expect(passage).toBeVisible();
    await expect(passage).toHaveJSProperty('tagName', 'P');
    await expect(panel.getByText(/주요 내용이다.*맞는 것은/)).toHaveJSProperty('tagName', 'P');
  } else {
    await expect(itemList(panel).getByRole('listitem')).toHaveCount(4);
  }
  for (const option of example.options) await expect(panelUi.option(panel, option)).toBeVisible();
  expect((await getQuestion(owner, question.id)).revision.stem).toBe(example.stem);
}

test(
  'UX11-STEM-AC01 range and labelled items',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ux11StemCase(page, workspaceFactory, 0);
  },
);
test(
  'UX11-STEM-AC02 bullets and inline blanks',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ux11StemCase(page, workspaceFactory, 1);
  },
);
test('UX11-STEM-AC03 auxiliary passage', { tag: '@infra' }, async ({ page, workspaceFactory }) => {
  await ux11StemCase(page, workspaceFactory, 2);
});
test(
  'UX11-STEM-AC04 options remain unchanged',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ux11StemCase(page, workspaceFactory, 0);
  },
);
test(
  'UX11-STEM-AC05 stored text remains unchanged',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ux11StemCase(page, workspaceFactory, 1);
  },
);

test(
  'UX11-STEM-AC03 range references and earlier paragraphs keep their boundaries',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { readFileSync } = await import('node:fs');
    const cases = JSON.parse(readFileSync('tests/fixtures/ux11-boundaries.json', 'utf8')) as {
      stem: string;
      kind: string;
      paragraphs?: string[];
    }[];
    const owner = await workspaceFactory.member('ux11-boundaries');
    const workspace = await workspaceFactory.create(owner);
    const range = cases[0];
    const passage = cases.find((entry) => entry.kind === 'passage');
    if (!range || !passage || !passage.paragraphs) throw new Error('missing boundary fixture');
    await createQuestion(owner, workspace.id, {
      question_number: 1,
      ...mcqInput(range.stem, ['첫째', '둘째'], 0),
    });
    await createQuestion(owner, workspace.id, {
      question_number: 2,
      ...mcqInput(passage.stem, ['첫째', '둘째'], 0),
    });
    await signInAs(page, owner.user);
    await page.goto(overviewPath(workspace.id));
    await expect(overviewUi.heatmap(page)).toBeVisible();
    await overviewUi.dot(page, 1).click();
    let panel = panelUi.numbered(page, 1);
    await expect(itemList(panel).getByRole('listitem')).toHaveCount(4);
    await panelUi.close(panel).click();
    await expect(panel).toBeHidden();
    await overviewUi.dot(page, 2).click();
    panel = panelUi.numbered(page, 2);
    for (const paragraph of passage.paragraphs) {
      await expect(panel.getByText(paragraph, { exact: true })).toHaveJSProperty('tagName', 'P');
    }
  },
);

test(
  'UX11-STEM-AC02 inline subtraction stays inside its bullet',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const stem = '다음은? ( ) - 이익은 ((수익)) - 비용으로 계산한다. - 세금은 별도이다.';
    const owner = await workspaceFactory.member('ux11-inline-minus');
    const workspace = await workspaceFactory.create(owner);
    await createQuestion(owner, workspace.id, {
      question_number: 1,
      ...mcqInput(stem, ['첫째', '둘째'], 0),
    });
    await signInAs(page, owner.user);
    await page.goto(overviewPath(workspace.id));
    await expect(overviewUi.heatmap(page)).toBeVisible();
    await overviewUi.dot(page, 1).click();
    const items = itemList(panelUi.numbered(page, 1)).getByRole('listitem');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveText('- 이익은 ((수익)) - 비용으로 계산한다.');
    await expect(items.nth(1)).toHaveText('- 세금은 별도이다.');
  },
);
