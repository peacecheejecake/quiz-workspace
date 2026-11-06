// UX12 EXPL-1 — the AI 해설 toolbar, its disclosure heading and the "작성중..." text
// (docs/screens/ux12-explanations.md; user feedback 2026-11-06).
//
// Results show answers and explanations: traces, screenshots and videos are off and the page text
// is not attached on failure; assertions use synthetic strings only.
import type { Locator, Page } from '@playwright/test';
import { outlineNodeId, uploadReadyBook } from '../fixtures/documents.ts';
import {
  bank,
  correctText,
  EXPL_TEXT,
  ExplHold,
  explMcq,
  explUi,
  expectDone,
  recordAnnouncements,
  seedExplanation,
} from '../fixtures/ai-explanations.ts';
import { relatedUi } from '../fixtures/related-sources.ts';
import {
  createShareLink,
  expect,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  sharedUi,
  test,
} from '../fixtures/sharing.ts';
import {
  createQuestion,
  overviewPath,
  overviewUi,
  panelUi,
  RESULT_TEXT,
  signInAs,
} from '../fixtures/test.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({
  storageState: { cookies: [], origins: [] },
  ...NO_VISUAL_ARTIFACTS,
  attachPageTextOnFailure: false,
});

const OLD_SHOW = /^AI 해설 보기$/;

async function setup(
  workspaceFactory: WorkspaceFactory,
  label: string,
  markers: readonly string[] = [],
) {
  const owner = await workspaceFactory.member(label);
  const workspace = await workspaceFactory.create(owner);
  const documentId = await uploadReadyBook(owner, workspace.id, 'book-ko');
  const chapter = await outlineNodeId(owner, documentId, '1장 물의 순환');
  const question = await createQuestion(
    owner,
    workspace.id,
    explMcq(label, 1, documentId, chapter, markers),
  );
  return { owner, workspace, question };
}

async function openSubmitted(
  page: Page,
  { owner, workspace, question }: Awaited<ReturnType<typeof setup>>,
): Promise<Locator> {
  await signInAs(page, owner.user);
  await page.goto(overviewPath(workspace.id));
  await overviewUi.dot(page, 1).click();
  const panel = panelUi.numbered(page, 1);
  await panelUi.option(panel, correctText(question)).check();
  await panelUi.submit(panel).click();
  await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
  return panel;
}

test(
  'UX12-EXPL-AC01 the heading right below AI 질문하기 collapses and expands the explanation',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await setup(workspaceFactory, 'ux12-expl-ac01');
    await seedExplanation(s.owner, bank(s.question.id));
    const panel = await openSubmitted(page, s);
    const area = explUi.area(panel);
    const toggle = explUi.show(area);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(explUi.badge(area)).toBeVisible();
    await expect(area.getByRole('button', { name: OLD_SHOW })).toHaveCount(0);

    const ask = await explUi.askAbout(area).boundingBox();
    const heading = await toggle.boundingBox();
    expect(ask && heading && heading.y >= ask.y + ask.height).toBe(true);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(explUi.badge(area)).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(explUi.badge(area)).toBeVisible();
  },
);

test(
  'UX12-EXPL-AC02 the heading looks like the 관련 본문 heading',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await setup(workspaceFactory, 'ux12-expl-ac02');
    await seedExplanation(s.owner, bank(s.question.id));
    const panel = await openSubmitted(page, s);
    const look = (toggle: Locator) =>
      toggle.evaluate((el) => {
        const css = getComputedStyle(el);
        return {
          fontSize: css.fontSize,
          fontWeight: css.fontWeight,
          border: css.border,
          height: el.getBoundingClientRect().height,
          chevrons: el.querySelectorAll('svg').length,
        };
      });
    const explanation = await look(explUi.show(explUi.area(panel)));
    expect(explanation.chevrons).toBe(1);
    expect(explanation).toEqual(await look(relatedUi.toggle(panel)));
  },
);

test(
  'UX12-EXPL-AC03 a share guest collapses the explanation by the same heading',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await setup(workspaceFactory, 'ux12-expl-ac03');
    await seedExplanation(s.owner, bank(s.question.id));
    const link = await createShareLink(s.owner, s.workspace.id);
    await openShareWithSecret(page, link.id, link.secret);
    await sharedUi.question(page, s.question.revision.stem).click();
    const area = explUi.sharedArea(sharedUi.questionPanel(page));
    const toggle = explUi.sharedToggle(area);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(explUi.heading(area).getByRole('button')).toHaveCount(1);
    await expect(area.getByRole('button', { name: OLD_SHOW })).toHaveCount(0);
    await toggle.click();
    await expect(explUi.badge(area)).toHaveCount(0);
    await toggle.click();
    await expect(explUi.badge(area)).toBeVisible();
  },
);

test(
  'UX12-EXPL-AC04 making one reads 작성중... and the heading becomes the toggle when done',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const hold = new ExplHold();
    const s = await setup(workspaceFactory, 'ux12-expl-ac04', [hold.marker]);
    const panel = await openSubmitted(page, s);
    const area = explUi.area(panel);
    const announcements = await recordAnnouncements(page);
    await explUi.create(area).click();
    await hold.held();
    await expect(area.getByText('작성중...', { exact: true }).first()).toBeVisible();
    await expect(area.getByRole('status')).toHaveText('작성중...');
    await expect(area.getByText(/AI 해설을 만드는 중/)).toHaveCount(0);
    await expect(explUi.heading(area).getByRole('button')).toHaveCount(0);
    hold.release();
    await expectDone(area);
    await expect(explUi.show(area)).toHaveAttribute('aria-expanded', 'true');
    expect(await announcements.read()).toEqual([
      expect.stringMatching(/^작성중\.\.\.$/),
      expect.stringMatching(EXPL_TEXT.ready),
    ]);
  },
);
