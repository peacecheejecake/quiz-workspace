// M7.2 accessibility of the DOCVIEW-01 document viewer layout (DOCVIEW-PORT,
// docs/screens/documents-viewer-layout.md "품질 suite"; A11Y-16 — A11Y-13 is UX7-DEDUP's and
// A11Y-14/15 are reserved by MOCK-SYNC): axe in the light and dark theme
// (fixtures/a11y.ts) on the DOC-02 screen in its viewer settings — 원본 기본, 함께 보기 · 좌우 ·
// 목차 펼침, 상하, 목차 접힘 — and on a narrow screen (390px) with the full-height outline
// panel open.
//
// Settings live in the browser's localStorage only; each test has its own context, so it starts
// from the defaults and changes them through the 보기 설정 bar.
import type { Page } from '@playwright/test';
import { expectAccessible } from '../fixtures/a11y.ts';
import {
  expectFitsViewport,
  expectSinglePane,
  expectSplit,
  viewerUi,
} from '../fixtures/document-viewer.ts';
import {
  editorUi,
  expect,
  JOB_TIMEOUT_MS,
  signInAs,
  test,
  uploadReadyBook,
} from '../fixtures/test.ts';

test.describe.configure({ timeout: JOB_TIMEOUT_MS + 90_000 });

const DESKTOP = { width: 1280, height: 800 } as const;
const NARROW = { width: 390, height: 844 } as const;

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await expect(editorUi.viewer(page).locator('canvas').first()).toBeVisible();
  // Regression guard: the split area fills the rest of the viewport, the page never scrolls.
  await expectFitsViewport(page);
}

test(
  'A11Y-16 document viewer layout (default, 원본만, 상하, outline collapsed, narrow outline panel)',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.setViewportSize(DESKTOP);
    const owner = await workspaceFactory.member('a11y16');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    await signInAs(page, owner.user);

    // Fresh settings show the original; select both for split accessibility checks.
    await page.goto(`/workspaces/${ws.id}/documents/${documentId}`);
    await expect(viewerUi.settingsBar(page)).toBeVisible();
    await expect(viewerUi.outlinePanel(page)).toBeVisible();
    await expect(viewerUi.mode(page, 'pdf')).toBeChecked();
    await expect(viewerUi.mode(page, 'text')).not.toBeChecked();
    await viewerUi.mode(page, 'text').check();
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: 50 });
    await settle(page);
    await expectAccessible(page, 'document viewer default (both, left/right, outline open)');

    // 원본만: the converted-text pane stays mounted but hidden.
    await viewerUi.mode(page, 'text').uncheck();
    await expect(viewerUi.mode(page, 'pdf')).toBeChecked();
    await expectSinglePane(page, 'pdf');
    await settle(page);
    await expectAccessible(page, 'document viewer PDF only');

    // 함께 보기 · 상하.
    await viewerUi.mode(page, 'text').check();
    await viewerUi.orientation(page, 'vertical').click();
    await expect(viewerUi.orientation(page, 'vertical')).toBeChecked();
    await expectSplit(page, { orientation: 'vertical', first: 'pdf', pdfRatio: 50 });
    await settle(page);
    await expectAccessible(page, 'document viewer top/bottom split');

    // 목차 접힘: only the bar's 목차 펼치기 toggle remains.
    await viewerUi.collapseOutline(page).click();
    await expect(viewerUi.expandOutline(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(viewerUi.outlinePanel(page)).toBeHidden();
    await expectFitsViewport(page);
    await expectAccessible(page, 'document viewer outline collapsed');

    // Narrow screen: both panes stacked and the full-height outline panel.
    await page.setViewportSize(NARROW);
    await expect(viewerUi.narrowSwitch(page)).toBeVisible();
    await expectFitsViewport(page);
    await viewerUi.narrowOutlineButton(page).click();
    await expect(viewerUi.outlinePanel(page)).toBeVisible();
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await expectAccessible(page, 'document viewer narrow screen with the outline panel open');
  },
);
