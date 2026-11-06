// UX12 VIEW-4 — `원문 보기` in the question panel's menu opens the QSRC-01 dialog; the body button
// stays (docs/screens/ux12-source-menu.md). Questions come from the real import flow and no LLM
// runs (fixtures/question-source.ts). Nothing is submitted here, but the imported paper carries an
// answer key, so visual artifacts stay off as in the QSRC-01 spec.
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { mockExamsPath, mockUi } from '../fixtures/mock-exams.ts';
import { openRangePicker, runUi } from '../fixtures/practice-runs.ts';
import {
  boxOf,
  isInert,
  panelByStem,
  seedQuestionSource,
  sourceUi,
  stemOf,
  watchRegionTraffic,
} from '../fixtures/question-source.ts';
import { NO_VISUAL_ARTIFACTS } from '../fixtures/sharing.ts';
import {
  expect,
  homeUi,
  JOB_TIMEOUT_MS,
  overviewPath,
  panelUi,
  PANEL_MANAGE_ITEMS,
  seedMembership,
  signInAs,
  test,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] }, ...NO_VISUAL_ARTIFACTS });
test.describe.configure({ timeout: 3 * JOB_TIMEOUT_MS + 120_000 });

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 375, height: 812 };

function unique(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

function stemKey(q: Question): string {
  return stemOf(q)
    .replace(/^\s*\d+[.)]\s*/, '')
    .slice(0, 12);
}

async function openHome(page: Page, member: Member, workspaceId: string): Promise<void> {
  await signInAs(page, member.user);
  await page.goto(overviewPath(workspaceId));
  await expect(homeUi.questionMenuButton(page)).toBeVisible();
}

async function openQuestion(page: Page, workspaceId: string, q: Question): Promise<Locator> {
  await page.goto(overviewPath(workspaceId, q.id));
  const panel = page.getByRole('dialog').filter({ hasText: stemKey(q) });
  await expect(panel).toBeVisible();
  return panel;
}

const menuButton = (panel: Locator) => panelUi.manage(panel).or(panelUi.info(panel));

async function advance(panel: Locator): Promise<void> {
  await runUi.next(panel).click();
}

test(
  'UX12-SRCMENU-AC01 the 문제 관리 menu opens the 문제 원문 dialog, the body button stays and focus returns to the menu',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, unique('srcmenu-ac01'));
    await page.setViewportSize(DESKTOP);
    await openHome(page, s.owner, s.workspaceId);
    const traffic = watchRegionTraffic(page);
    const panel = await openQuestion(page, s.workspaceId, s.single);
    await expect(sourceUi.button(panel)).toBeVisible();
    const url = page.url();

    await panelUi.manage(panel).click();
    const names = await page.getByRole('menu').getByRole('menuitem').allInnerTexts();
    const history = names.findIndex((name) => PANEL_MANAGE_ITEMS.history.test(name));
    expect(names[history + 1], 'the item follows 수정 이력·출처').toMatch(
      PANEL_MANAGE_ITEMS.source,
    );
    expect(traffic.pdfRequests(), 'no PDF request before the item is chosen').toBe(0);

    await panelUi.manageItem(page, 'source').click();
    const dialog = sourceUi.dialog(page);
    await expect(sourceUi.figure(dialog, 1)).toBeVisible();
    await expect(sourceUi.forbiddenControls(dialog)).toHaveCount(0);
    const question = panelByStem(page, stemKey(s.single));
    const box = await boxOf(dialog);
    expect(box.x + box.width, 'left of the panel').toBeLessThanOrEqual(
      (await boxOf(question)).x + 1,
    );
    expect(await isInert(question), 'the question panel is inert while open').toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(panelUi.manage(panel)).toBeFocused();
    await expect(sourceUi.button(panel)).toBeVisible();
    expect(page.url()).toBe(url);
  },
);

test(
  'UX12-SRCMENU-AC02 the item exists only for a question with a region, in the read-only 문제 정보 menu too',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, unique('srcmenu-ac02'));
    await page.setViewportSize(DESKTOP);
    await openHome(page, s.owner, s.workspaceId);
    const traffic = watchRegionTraffic(page);
    const manual = await openQuestion(page, s.workspaceId, s.manual);
    await expect
      .poll(() => traffic.statuses.get(s.manual.id), { message: 'manual region answered 404' })
      .toBe(404);
    await panelUi.manage(manual).click();
    await expect(panelUi.manageItem(page, 'history')).toBeVisible();
    await expect(panelUi.manageItem(page, 'source')).toHaveCount(0);
    await page.keyboard.press('Escape');

    const viewer = await workspaceFactory.member('srcmenu-ac02-viewer');
    // fixtures/db.ts use 2: no membership API creates a viewer.
    seedMembership(s.workspaceId, viewer.user.id, 'viewer');
    await page.context().clearCookies();
    await openHome(page, viewer, s.workspaceId);
    const panel = await openQuestion(page, s.workspaceId, s.single);
    await expect(sourceUi.button(panel)).toBeVisible();
    await panelUi.info(panel).click();
    await panelUi.manageItem(page, 'source').click();
    const dialog = sourceUi.dialog(page);
    await expect(sourceUi.figures(dialog).first()).toBeVisible();
    await sourceUi.close(dialog).click();
    await expect(dialog).toHaveCount(0);
    await expect(panelUi.info(panel)).toBeFocused();
  },
);

test(
  'UX12-SRCMENU-AC03 range practice offers the item per position and sequence(mock) keeps only the body button',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, unique('srcmenu-ac03'), { mocks: true });
    const { mockImported } = s;
    if (!mockImported) throw new Error('mock exams were not seeded');
    await page.setViewportSize(DESKTOP);
    await openHome(page, s.owner, s.workspaceId);
    const traffic = watchRegionTraffic(page);

    let run = await openRangePicker(page);
    await runUi.selectAll(run).check();
    await runUi.start(run).click();
    await expect(page).toHaveURL(/[?&]practice=[0-9a-f-]{36}(&|$)/);
    run = runUi.panel(page);
    await expect(sourceUi.button(run)).toBeVisible();
    await menuButton(run).click();
    await panelUi.manageItem(page, 'source').click();
    const dialog = sourceUi.dialog(page);
    await expect(sourceUi.figures(dialog).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(menuButton(run)).toBeFocused();

    // Questions 1 and 5 have a region; the third position is the manual question.
    await advance(run);
    await expect(sourceUi.button(run)).toBeVisible();
    await advance(run);
    await expect
      .poll(() => traffic.statuses.get(s.manual.id), { message: 'manual region answered 404' })
      .toBe(404);
    await expect(sourceUi.button(run)).toHaveCount(0);
    await menuButton(run).click();
    await expect(panelUi.manageItem(page, 'history')).toBeVisible();
    await expect(panelUi.manageItem(page, 'source')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.goto(mockExamsPath(s.workspaceId));
    const list = mockUi.dialog(page);
    await expect(list).toBeVisible();
    await mockUi.rowTitle(mockUi.row(list, mockImported.title)).click();
    const mockPanel = mockUi.practicePanel(page);
    await runUi.start(mockPanel).click();
    await expect(runUi.mockTitle(mockPanel, 1)).toBeVisible();
    await expect(sourceUi.button(mockPanel)).toBeVisible();
    await expect(menuButton(mockPanel)).toHaveCount(0);
    await sourceUi.button(mockPanel).click();
    await expect(sourceUi.figures(sourceUi.dialog(page)).first()).toBeVisible();
  },
);

test(
  'UX12-SRCMENU-AC04 on a phone the item opens the full-screen sheet and Back closes only the sheet',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, unique('srcmenu-ac04'));
    await page.setViewportSize(PHONE);
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openQuestion(page, s.workspaceId, s.single);
    await expect(sourceUi.button(panel)).toBeVisible();
    const url = page.url();

    await panelUi.manage(panel).click();
    await panelUi.manageItem(page, 'source').click();
    const dialog = sourceUi.dialog(page);
    await expect(sourceUi.figures(dialog).first()).toBeVisible();
    const box = await boxOf(dialog);
    expect(box.width).toBe(PHONE.width);
    expect(box.height).toBe(PHONE.height);

    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(panelUi.manage(panel)).toBeFocused();
    expect(page.url()).toBe(url);
  },
);
