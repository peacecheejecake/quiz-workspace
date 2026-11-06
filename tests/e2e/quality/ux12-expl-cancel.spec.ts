// UX12 EXPL-3 — cancelling an AI explanation being made (docs/screens/ux12-expl-cancel.md; user
// feedback 2026-11-06). The API, role and worker cases are contract tests (test_ux12_explcancel_*).
//
// Results show answers and explanations: traces, screenshots and videos are off and the page text
// is not attached on failure; assertions use synthetic strings only.
import type { Locator, Page } from '@playwright/test';
import { seedMembership } from '../fixtures/db.ts';
import { outlineNodeId, uploadReadyBook } from '../fixtures/documents.ts';
import {
  bank,
  correctText,
  EXPL_TEXT,
  ExplHold,
  explMcq,
  explanationRow,
  explUi,
  expectDone,
  getExplanation,
  seedExplanation,
} from '../fixtures/ai-explanations.ts';
import { expect, NO_VISUAL_ARTIFACTS, test } from '../fixtures/sharing.ts';
import {
  createQuestion,
  overviewPath,
  overviewUi,
  panelUi,
  RESULT_TEXT,
  signInAs,
} from '../fixtures/test.ts';
import type { Member, WorkspaceFactory } from '../fixtures/workspaces.ts';
import type { Question } from '../fixtures/questions.ts';

test.use({
  storageState: { cookies: [], origins: [] },
  ...NO_VISUAL_ARTIFACTS,
  attachPageTextOnFailure: false,
});

async function setup(workspaceFactory: WorkspaceFactory, label: string, marker: string) {
  const owner = await workspaceFactory.member(label);
  const workspace = await workspaceFactory.create(owner);
  const documentId = await uploadReadyBook(owner, workspace.id, 'book-ko');
  const chapter = await outlineNodeId(owner, documentId, '1장 물의 순환');
  const question = await createQuestion(
    owner,
    workspace.id,
    explMcq(label, 1, documentId, chapter, [marker]),
  );
  return { owner, workspace, question };
}

async function openSubmitted(
  page: Page,
  member: Member,
  workspaceId: string,
  question: Question,
): Promise<Locator> {
  await signInAs(page, member.user);
  await page.goto(overviewPath(workspaceId));
  await overviewUi.dot(page, 1).click();
  const panel = panelUi.numbered(page, 1);
  await panelUi.option(panel, correctText(question)).check();
  await panelUi.submit(panel).click();
  await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
  return panel;
}

test(
  'UX12-EXPLCANCEL-AC01 cancelling a new one leaves only the toolbar, and nothing is stored',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const hold = new ExplHold();
    const s = await setup(workspaceFactory, 'ux12-cancel-ac01', hold.marker);
    const panel = await openSubmitted(page, s.owner, s.workspace.id, s.question);
    const area = explUi.area(panel);
    await explUi.create(area).click();
    await hold.held();
    await expect(area.getByText(EXPL_TEXT.working).first()).toBeVisible();

    const live = await getExplanation(s.owner, bank(s.question.id), { view: 'detail' });
    const id = live.body?.explanation?.id ?? '';
    await explUi.cancel(area).click();

    await expect(explUi.region(panel)).toHaveCount(0);
    await expect(explUi.create(area)).toBeFocused();
    await expect(area.getByRole('status')).toHaveText(EXPL_TEXT.cancelled);
    await expect(explUi.alert(area)).toHaveCount(0);

    hold.release();
    await expect
      .poll(() => explanationRow(id), { message: 'the worker leaves the row cancelled' })
      .toBe('failed|cancelled');
    const after = await getExplanation(s.owner, bank(s.question.id), { view: 'detail' });
    expect(after.body?.explanation).toBeNull();
    expect(after.body?.can_create).toBe(true);

    await explUi.create(area).click();
    await expectDone(area);
  },
);

test(
  'UX12-EXPLCANCEL-AC02 cancelling a regeneration brings the current one back',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const hold = new ExplHold();
    const s = await setup(workspaceFactory, 'ux12-cancel-ac02', hold.marker);
    hold.release();
    await seedExplanation(s.owner, bank(s.question.id));
    hold.rearm();

    const panel = await openSubmitted(page, s.owner, s.workspace.id, s.question);
    const area = explUi.area(panel);
    await expectDone(area);
    await explUi.regenerate(area).click();
    await hold.held();
    await explUi.cancel(area).click();

    await expectDone(area);
    await expect(area.getByText(/버전 2/)).toHaveCount(0);
    await expect(explUi.heading(area)).toBeFocused();
    await expect(area.getByRole('status')).toHaveText(EXPL_TEXT.cancelled);
    await expect(explUi.alert(area)).toHaveCount(0);
    await expect(explUi.regenerate(area)).toBeVisible();
    hold.release();
  },
);

test(
  'UX12-EXPLCANCEL-AC03 a member without the right sees no 취소 and follows the requester',
  { tag: '@infra' },
  async ({ browser, page, workspaceFactory }) => {
    const hold = new ExplHold();
    const s = await setup(workspaceFactory, 'ux12-cancel-ac03', hold.marker);
    const viewer = await workspaceFactory.member('ux12-cancel-ac03-viewer');
    seedMembership(s.workspace.id, viewer.user.id, 'viewer');

    const panel = await openSubmitted(page, s.owner, s.workspace.id, s.question);
    const area = explUi.area(panel);
    await explUi.create(area).click();
    await hold.held();

    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const other = await context.newPage();
    const theirs = explUi.area(await openSubmitted(other, viewer, s.workspace.id, s.question));
    await expect(theirs.getByText(EXPL_TEXT.working).first()).toBeVisible();
    await expect(explUi.cancel(theirs)).toHaveCount(0);

    await explUi.cancel(area).click();
    await expect(explUi.create(theirs)).toBeVisible();
    await expect(explUi.alert(theirs)).toHaveCount(0);
    hold.release();
    await context.close();
  },
);

test(
  'UX12-EXPLCANCEL-AC04 취소 works from the keyboard',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const hold = new ExplHold();
    const s = await setup(workspaceFactory, 'ux12-cancel-ac04', hold.marker);
    const panel = await openSubmitted(page, s.owner, s.workspace.id, s.question);
    const area = explUi.area(panel);
    await explUi.create(area).click();
    await hold.held();
    const button = explUi.cancel(area);
    await expect(button).toBeVisible();
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(explUi.create(area)).toBeFocused();
    hold.release();
  },
);
