// UX12-PASSAGE (docs/screens/ux12-stem-passages.md): <제목> passages shown in their own boxes.
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

const STEM =
  '다음 자료를 보고 옳은 것만 고른 것은? ( ) <물건 현황> ∙소재지 : 가람시 나무동 12 ∙보증금 : 3억원 ' +
  '∙임대 기간 : 2026.6.10. ~ 2028.6.9. ∙서울·부산 노선은 하루 10 - 3 편이다 <보유 자산> ∙가람아파트 ' +
  '- 취득 정보 : 2020년 4억원 - 현재 시세 : 5억원 ∙누리상가 - 취득 정보 : 2021년 2억원 ' +
  '- 현재 시세 : 3억원 (가) 갑은 보증금을 돌려받는다. (나) 을은 취득세를 낸다. (다) 병은 시세를 신고한다.';
const OPTIONS = ['(가)', '(나)', '(가), (나)', '(가), (다)'];

async function openStem(
  page: Page,
  workspaceFactory: E2EFixtures['workspaceFactory'],
  name: string,
  stem: string,
) {
  const owner = await workspaceFactory.member(name);
  const workspace = await workspaceFactory.create(owner);
  const question = await createQuestion(owner, workspace.id, {
    question_number: 1,
    ...mcqInput(stem, OPTIONS, 0),
  });
  await signInAs(page, owner.user);
  await page.goto(overviewPath(workspace.id));
  await expect(overviewUi.heatmap(page)).toBeVisible();
  await overviewUi.dot(page, 1).click();
  const panel = panelUi.numbered(page, 1);
  await expect(panel).toBeVisible();
  // The stem first shows as the loading preview, and the loaded body replaces those elements.
  await expect(panelUi.options(panel).first()).toBeVisible();
  return { owner, question, panel };
}

const box = (panel: Locator, name: string) => panel.getByRole('region', { name });
const items = (panel: Locator) => panel.getByRole('list', { name: /^(제시 항목|stem items)$/i });

test(
  'UX12-PASSAGE-AC01 each passage has its own titled box before the item list',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { panel } = await openStem(page, workspaceFactory, 'ux12-passage-1', STEM);
    await expect(panel.getByText('다음 자료를 보고 옳은 것만 고른 것은?')).toHaveJSProperty(
      'tagName',
      'P',
    );
    const first = box(panel, '<물건 현황>');
    const second = box(panel, '<보유 자산>');
    await expect(first.getByRole('heading', { name: '<물건 현황>' })).toBeVisible();
    await expect(second.getByRole('heading', { name: '<보유 자산>' })).toBeVisible();
    await expect(items(panel).getByRole('listitem')).toHaveCount(3);

    const a = await first.boundingBox();
    const b = await second.boundingBox();
    const c = await items(panel).boundingBox();
    if (!a || !b || !c) throw new Error('passage boxes must be laid out');
    expect(b.y).toBeGreaterThan(a.y + a.height);
    expect(c.y).toBeGreaterThan(b.y + b.height);
  },
);

test(
  'UX12-PASSAGE-AC02 items break at item boundaries only',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { panel } = await openStem(page, workspaceFactory, 'ux12-passage-2', STEM);
    const first = box(panel, '<물건 현황>');
    await expect(first.getByRole('listitem')).toHaveText([
      /소재지 : 가람시 나무동 12$/,
      /보증금 : 3억원$/,
      /임대 기간 : 2026\.6\.10\. ~ 2028\.6\.9\.$/,
      /서울·부산 노선은 하루 10 - 3 편이다$/,
    ]);
    const parent = box(panel, '<보유 자산>')
      .getByRole('listitem')
      .filter({ hasText: '가람아파트' });
    const subs = parent.getByRole('list').getByRole('listitem');
    await expect(subs).toHaveText([/취득 정보 : 2020년 4억원$/, /현재 시세 : 5억원$/]);
    const lead = await parent.getByText('가람아파트').boundingBox();
    const sub = await subs.first().boundingBox();
    if (!lead || !sub) throw new Error('item lines must be laid out');
    expect(sub.x).toBeGreaterThan(lead.x);
    expect(sub.y).toBeGreaterThan(lead.y);
  },
);

test(
  'UX12-PASSAGE-AC03 mentions and bodiless headings stay; the stored stem is unchanged',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const stem = '다음 <보기> 에 대한 설명 중 옳은 것은? <보기> (가) 갑이다. (나) 을이다.';
    const { owner, question, panel } = await openStem(
      page,
      workspaceFactory,
      'ux12-passage-3',
      stem,
    );
    await expect(panel.getByRole('region', { name: /<보기>/ })).toHaveCount(0);
    await expect(items(panel).getByRole('listitem')).toHaveCount(2);
    await expect(
      panel.getByText(/다음 <보기> 에 대한 설명 중 옳은 것은\? <보기>/),
    ).toHaveJSProperty('tagName', 'P');
    expect((await getQuestion(owner, question.id)).revision.stem).toBe(stem);
  },
);

for (const [label, viewport] of [
  ['375 px', { width: 375, height: 800 }],
  ['desktop', { width: 1280, height: 800 }],
] as const) {
  test(
    `UX12-PASSAGE-AC04 boxes stay inside the panel at ${label}`,
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await page.setViewportSize(viewport);
      const { panel } = await openStem(
        page,
        workspaceFactory,
        `ux12-passage-4-${viewport.width}`,
        STEM.replace('가람시 나무동 12', `가람시 ${'나무동'.repeat(30)} 12`),
      );
      const parts = [box(panel, '<물건 현황>'), box(panel, '<보유 자산>'), items(panel)];
      for (const part of parts) await expect(part).toBeVisible();
      const panelBox = await panel.boundingBox();
      for (const part of parts) {
        const area = await part.boundingBox();
        if (!panelBox || !area) throw new Error('boxes must be laid out');
        expect(area.x).toBeGreaterThanOrEqual(panelBox.x);
        expect(area.x + area.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    },
  );
}
