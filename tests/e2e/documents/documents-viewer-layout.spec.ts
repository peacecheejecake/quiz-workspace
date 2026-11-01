// DOCVIEW-01 — PDF 열람 보기 설정 (목차 panel·보기 방식·분할), docs/screens/documents-viewer-layout.md:
// the layout of the DOC-02 document screen (`/workspaces/:workspaceId/documents/:documentId`) and
// of the WS-VIEW-01 shared document view (`/share/:shareId`).
//
// Each test uploads the synthetic `book-ko.pdf` into its own workspace (public upload flow) and
// opens it in its own browser context, so the per-browser settings in localStorage never leak
// between tests; stored settings are seeded with init scripts. The viewport is set per test.
// Sections/pages/blocks come from tests/fixtures/pdfs/book-ko.truth.json. The UI label contract
// and the storage shape are in fixtures/document-viewer.ts.
//
// DOCVIEW-PORT (2026-11-02): this layout replaced DOC-02-AC06 (toolbar outline toggle) and
// DOC-02-AC10 (PDF/원문 width separator) on top of DOC-02 v1.4: the PDF pane is the continuous
// scroll viewer (AC07), the text pane groups blocks under `N쪽` headings (AC09, aria-current="page"
// on the current one) and follows the PDF (AC08) in every mode, orientation and order.
//
// Failure artifacts carry no document text: the sharing fixture blanks the page on failure without
// attaching its text (`attachPageTextOnFailure: false`), and assertions on shown book text are
// boolean polls, so a failure message never quotes it. Trace/screenshot/video are off for the file
// because the guest test (AC12) passes a share secret through the browser.
import type { Locator, Page } from '@playwright/test';
import {
  breakBrowserStorage,
  DEFAULT_VIEWER_SETTINGS,
  expectDropHint,
  expectFitsViewport,
  expectSinglePane,
  expectSplit,
  measureSplit,
  mouseDragStart,
  overlaps,
  boxOf,
  center,
  readViewerSettings,
  recordApiRequests,
  sampleViewerFit,
  seedViewerSettings,
  selectionText,
  storageKeys,
  touchDragStart,
  viewerUi,
  VIEWER_SETTINGS_KEY,
  writeViewerSettingsRaw,
  type PaneId,
  type ViewerSettings,
} from '../fixtures/document-viewer.ts';
import {
  createShareLink,
  expect,
  expectFragmentRemoved,
  expectUrl,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  seedSharedContent,
  sharedUi,
  ShareSession,
  test,
} from '../fixtures/sharing.ts';
import {
  block,
  book,
  DRAFT_SAVED,
  editorUi,
  JOB_TIMEOUT_MS,
  section,
  seedMembership,
  sha256,
  signInAs,
  snippet,
  uniqueWorkspaceName,
  uploadReadyBook,
} from '../fixtures/test.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

// Trace/screenshot/video are worker options (top level only): off for the whole file because the
// guest test (AC12) handles a share secret.
test.use({
  storageState: { cookies: [], origins: [] },
  attachPageTextOnFailure: false,
  ...NO_VISUAL_ARTIFACTS,
});
test.describe.configure({ timeout: 2 * JOB_TIMEOUT_MS + 90_000 });

const BOOK = book('book-ko');
const CH1_S2 = section(BOOK, 'ch1-s2'); // page 2
const CH2_S2 = section(BOOK, 'ch2-s2'); // page 4
const CH1_S2_FIRST = block(BOOK, 'ch1-s2-p1');
const CH2_S2_FIRST = block(BOOK, 'ch2-s2-p1');
const CHLORINE = block(BOOK, 'ch2-s2-p2'); // page 4

const DESKTOP = { width: 1440, height: 1000 } as const;
/**
 * Tall enough that 20% of a 상하 split is more than the 200px minimum (AC10 clamp); the page
 * content is at most 1440px wide (--content-max-width), so 20% of a 좌우 split never reaches 320px.
 */
const TALL = { width: 1440, height: 1800 } as const;

function documentPath(workspaceId: string, documentId: string): string {
  return `/workspaces/${workspaceId}/documents/${documentId}`;
}

/** Boolean poll: `locator`'s text contains `text` (the failure message never quotes book text). */
async function expectHasText(locator: Locator, text: string, message: string): Promise<void> {
  await expect
    .poll(async () => ((await locator.textContent({ timeout: 1_000 })) ?? '').includes(text), {
      message,
    })
    .toBe(true);
}

/** Boolean poll on a textbox value (never printed). */
async function expectValue(locator: Locator, value: string, message: string): Promise<void> {
  await expect
    .poll(async () => (await locator.inputValue({ timeout: 1_000 })) === value, { message })
    .toBe(true);
}

/** The block the outline jump selected is the text pane's current block. */
async function expectCurrentBlock(page: Page, text: string, message: string): Promise<void> {
  await expectHasText(viewerUi.currentBlock(page), snippet(text), message);
}

async function openOwnerDocument(
  page: Page,
  workspaceFactory: WorkspaceFactory,
  label: string,
  options: {
    viewport?: { width: number; height: number };
    settings?: Partial<ViewerSettings> | Record<string, unknown> | string;
  } = {},
) {
  if (options.viewport) await page.setViewportSize(options.viewport);
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
  if (options.settings !== undefined) await seedViewerSettings(page, options.settings);
  await signInAs(page, owner.user);
  const path = documentPath(ws.id, documentId);
  await page.goto(path);
  await expect(viewerUi.settingsBar(page)).toBeVisible();
  return { owner, workspaceId: ws.id, documentId, path };
}

/** Collapses the outline panel through the settings bar (no-op when it is collapsed). */
async function collapseOutline(page: Page): Promise<void> {
  const toggle = viewerUi.outlineToggle(page);
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
  await expect(viewerUi.expandOutline(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(viewerUi.outlinePanel(page)).toBeHidden();
}

async function chooseMode(page: Page, mode: 'both' | 'pdf' | 'text'): Promise<void> {
  await viewerUi.mode(page, mode).click();
  await expect(viewerUi.mode(page, mode)).toBeChecked();
}

async function chooseOrientation(page: Page, orientation: 'horizontal' | 'vertical') {
  await viewerUi.orientation(page, orientation).click();
  await expect(viewerUi.orientation(page, orientation)).toBeChecked();
}

/** Focuses the separator and presses `key` on it. */
async function pressOnSeparator(page: Page, key: string): Promise<void> {
  const separator = viewerUi.separator(page);
  await separator.focus();
  await separator.press(key);
}

/** DOC-02-AC09 inside the 변환본 pane: the `N쪽` group heading of the current page. */
async function expectCurrentPageGroup(page: Page, pageNumber: number, what: string) {
  await expect(
    viewerUi.pane(page, 'text').getByRole('heading', {
      name: new RegExp(`^(${pageNumber}쪽|page ${pageNumber})$`, 'i'),
    }),
    what,
  ).toHaveAttribute('aria-current', 'page');
}

/** The PDF pane shows `pageNumber` and the source highlight (DOC-02-AC01). */
async function expectPdfAt(page: Page, pageNumber: number, what: string): Promise<void> {
  await expect(viewerUi.currentPage(page), what).toHaveValue(String(pageNumber));
}

test(
  'DOCVIEW-01-AC01 by default the outline panel is open on the left and 원본/변환본 split 50:50 side by side',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await openOwnerDocument(page, workspaceFactory, 'docview01-ac01', {
      viewport: { width: 1280, height: 800 },
    });

    const panel = viewerUi.outlinePanel(page);
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('tree', { name: /목차|outline/i })).toBeVisible();
    await expect(viewerUi.collapseOutline(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(viewerUi.mode(page, 'both')).toBeChecked();
    await expect(viewerUi.orientation(page, 'horizontal')).toBeChecked();

    const split = await expectSplit(page, {
      orientation: 'horizontal',
      first: 'pdf',
      pdfRatio: 50,
    });
    expect(Math.abs(split.pdf.width - split.text.width), 'equal pane widths').toBeLessThanOrEqual(
      2,
    );
    // The docked panel sits left of both panes and covers neither.
    const panelBox = await boxOf(panel);
    expect(overlaps(panelBox, split.pdf), 'outline panel overlaps the PDF pane').toBe(false);
    expect(overlaps(panelBox, split.text), 'outline panel overlaps the text pane').toBe(false);
    expect(panelBox.x + panelBox.width, 'panel is left of the panes').toBeLessThanOrEqual(
      split.pdf.x + 1,
    );
  },
);

test(
  'DOCVIEW-01-AC02 the outline panel collapses and expands from the bar, Escape collapses it, and choosing a section keeps it open',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await openOwnerDocument(page, workspaceFactory, 'docview01-ac02', { viewport: DESKTOP });
    const panel = viewerUi.outlinePanel(page);
    await expect(panel).toBeVisible();
    const before = await expectSplit(page, {
      orientation: 'horizontal',
      first: 'pdf',
      pdfRatio: 50,
    });

    // Collapse: only the bar's toggle remains, both panes widen and stay 50:50.
    await viewerUi.collapseOutline(page).click();
    await expect(panel).toBeHidden();
    await expect(viewerUi.expandOutline(page)).toHaveAttribute('aria-expanded', 'false');
    const collapsed = await expectSplit(page, {
      orientation: 'horizontal',
      first: 'pdf',
      pdfRatio: 50,
    });
    expect(collapsed.pdf.width, 'PDF pane widens').toBeGreaterThan(before.pdf.width + 40);
    expect(collapsed.text.width, 'text pane widens').toBeGreaterThan(before.text.width + 40);

    // Expand: focus moves to a tree item inside the panel; with reduced motion nothing animates.
    await viewerUi.expandOutline(page).click();
    await expect(panel).toBeVisible();
    await expect(viewerUi.collapseOutline(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.getByRole('treeitem').and(page.locator(':focus'))).toHaveCount(1);
    const motion = await panel.evaluate((el) => {
      const durations = (value: string) =>
        value.split(',').map((part) => Number.parseFloat(part) || 0);
      const style = getComputedStyle(el);
      return {
        transition: Math.max(...durations(style.transitionDuration)),
        animation: Math.max(...durations(style.animationDuration)),
        running: el
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === 'running').length,
      };
    });
    expect(motion, 'no expand/collapse transition under prefers-reduced-motion').toEqual({
      transition: 0,
      animation: 0,
      running: 0,
    });

    // Escape inside the panel collapses it and returns focus to the toggle.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(viewerUi.expandOutline(page)).toBeFocused();
    await expect(viewerUi.expandOutline(page)).toHaveAttribute('aria-expanded', 'false');

    // Choosing a section keeps the panel open and moves the PDF and the text (DOC-02-AC01).
    await viewerUi.expandOutline(page).click();
    await expect(panel).toBeVisible();
    await viewerUi.outlineItem(page, CH2_S2.title).click();
    await expectPdfAt(page, CH2_S2.page, CH2_S2.title);
    await expect(viewerUi.highlight(page)).toBeVisible();
    await expectCurrentBlock(page, CH2_S2_FIRST.text, 'the section start is the current block');
    await expect(panel).toBeVisible();
  },
);

test(
  'DOCVIEW-01-AC03 view modes 원본 · 변환본 · 함께 보기 show one or both panes and keep the outline jumps',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await openOwnerDocument(page, workspaceFactory, 'docview01-ac03', { viewport: DESKTOP });
    await expect(viewerUi.mode(page, 'both')).toBeChecked();

    // 원본: the PDF only; a section moves its page.
    await chooseMode(page, 'pdf');
    await expect(viewerUi.mode(page, 'both')).not.toBeChecked();
    await expectSinglePane(page, 'pdf');
    await viewerUi.outlineItem(page, CH1_S2.title).click();
    await expectPdfAt(page, CH1_S2.page, 'section chosen while only the PDF shows');

    // 변환본: the text only; a section scrolls to its block and makes it current.
    await chooseMode(page, 'text');
    await expect(viewerUi.mode(page, 'pdf')).not.toBeChecked();
    await expectSinglePane(page, 'text');
    // The re-shown text pane is at the section chosen while it was hidden.
    await expectCurrentBlock(page, CH1_S2_FIRST.text, 'section chosen while the text was hidden');
    await expect(viewerUi.currentBlock(page)).toBeInViewport();
    await expectCurrentPageGroup(page, CH1_S2.page, 'page group of the hidden-time section');
    await viewerUi.outlineItem(page, CH2_S2.title).click();
    await expectCurrentBlock(page, CH2_S2_FIRST.text, 'section chosen while only the text shows');
    await expect(viewerUi.currentBlock(page)).toBeInViewport();

    // 함께 보기: both panes show the last section's page and block.
    await chooseMode(page, 'both');
    await expect(viewerUi.mode(page, 'text')).not.toBeChecked();
    await expect(viewerUi.pane(page, 'pdf')).toBeVisible();
    await expect(viewerUi.pane(page, 'text')).toBeVisible();
    await expect(viewerUi.separator(page)).toBeVisible();
    await expect(viewerUi.orientationGroup(page)).toBeVisible();
    await expect(viewerUi.swapButton(page)).toBeVisible();
    await expectPdfAt(page, CH2_S2.page, 'the PDF follows the section chosen in 변환본');
    // The re-shown PDF pane scrolled to that section's source (continuous scroll, DOC-02-AC08).
    await expect(viewerUi.highlight(page)).toBeInViewport();
    await expectCurrentBlock(page, CH2_S2_FIRST.text, 'the block stays current');
    await expectCurrentPageGroup(page, CH2_S2.page, 'page group of the section');
  },
);

test(
  'DOCVIEW-01-AC04 an unsaved edit survives switching to 원본 and back, and read-only members get every mode without editing UI',
  { tag: '@infra' },
  async ({ page, context, workspaceFactory }) => {
    const { workspaceId, path } = await openOwnerDocument(
      page,
      workspaceFactory,
      'docview01-ac04',
      {
        viewport: DESKTOP,
      },
    );
    const token = `보기전환표지${Date.now().toString(36)}`;
    const corrected = `${CH1_S2_FIRST.text} ${token}`;

    const target = viewerUi.textBlock(page, snippet(CH1_S2_FIRST.text));
    await editorUi.editButton(target).click();
    const textbox = viewerUi.pane(page, 'text').getByRole('textbox', {
      name: /블록|원문|변환본|block|text/i,
    });
    await textbox.fill(corrected);

    await chooseMode(page, 'pdf');
    await expectSinglePane(page, 'pdf');
    await chooseMode(page, 'both');
    await expect(textbox).toBeVisible();
    await expectValue(textbox, corrected, 'the unsaved input survives the mode switch');

    await viewerUi
      .pane(page, 'text')
      .getByRole('button', { name: /^(저장|save)/i })
      .click();
    await expect(editorUi.revisionStatus(page)).toContainText(DRAFT_SAVED);

    // The draft persists and the original PDF bytes are unchanged.
    const pdf = page.waitForResponse(
      (res) => res.status() === 200 && /application\/pdf/.test(res.headers()['content-type'] ?? ''),
    );
    await page.reload();
    expect(sha256(await (await pdf).body()), 'PDF bytes after the edit').toBe(BOOK.sha256);
    await expectHasText(viewerUi.pane(page, 'text'), token, 'the saved draft text');

    // A read-only member: same modes, no editing UI in any of them.
    const viewer = await workspaceFactory.member('docview01-ac04-viewer');
    seedMembership(workspaceId, viewer.user.id, 'viewer');
    await context.clearCookies();
    await signInAs(page, viewer.user);
    await page.goto(path);
    await expect(viewerUi.settingsBar(page)).toBeVisible();
    for (const mode of ['both', 'pdf', 'text'] as const) {
      await chooseMode(page, mode);
      if (mode === 'pdf') await expectSinglePane(page, 'pdf');
      else await expect(viewerUi.pane(page, 'text')).toBeVisible();
      await expect(
        page.getByRole('button', { name: /^(편집|수정|edit)/i }),
        `no edit button in ${mode}`,
      ).toHaveCount(0);
      await expect(editorUi.publishButton(page), `no publish button in ${mode}`).toHaveCount(0);
    }
  },
);

test(
  'DOCVIEW-01-AC05 dragging the splitter resizes the panes within their minimum sizes and a double click resets 50:50',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await openOwnerDocument(page, workspaceFactory, 'docview01-ac05', { viewport: DESKTOP });
    const separator = viewerUi.separator(page);
    const start = await expectSplit(page, {
      orientation: 'horizontal',
      first: 'pdf',
      pdfRatio: 50,
    });

    // Drag right by 150px: the PDF pane grows, the text pane shrinks, ARIA follows.
    const from = center(await boxOf(separator));
    await mouseDragStart(page, separator, { x: from.x + 150, y: from.y });
    expect(await selectionText(page), 'no text selected while dragging').toBe('');
    await page.mouse.up();
    let draggedRatio = 50;
    await expect(async () => {
      const m = await measureSplit(page, 'horizontal');
      draggedRatio = m.valueNow;
      expect(m.valueNow).toBeGreaterThan(50);
      expect(m.pdf.width - start.pdf.width, 'PDF pane widened by the drag').toBeGreaterThan(120);
      expect(start.text.width - m.text.width, 'text pane narrowed').toBeGreaterThan(120);
    }).toPass({ timeout: 10_000 });
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: draggedRatio });
    expect(await selectionText(page), 'no text selected after dragging').toBe('');

    // Drag far past the right end: the text pane stops at its minimum (≥ 20% and ≥ 320px).
    const viewport = page.viewportSize() ?? DESKTOP;
    const now = center(await boxOf(separator));
    await mouseDragStart(page, separator, { x: viewport.width - 2, y: now.y });
    await page.mouse.up();
    await expect(async () => {
      const m = await measureSplit(page, 'horizontal');
      const total = m.pdf.width + m.text.width;
      expect(m.valueNow, 'clamped at aria-valuemax').toBe(m.valueMax);
      expect(m.valueMax, 'max leaves the text pane at least 20%').toBeLessThanOrEqual(80);
      expect(m.text.width, 'text pane keeps 320px').toBeGreaterThanOrEqual(318);
      expect(m.text.width, 'text pane keeps 20%').toBeGreaterThanOrEqual(0.2 * total - 2);
      expect(m.valueNow).toBeGreaterThan(draggedRatio);
    }).toPass({ timeout: 10_000 });
    expect(await selectionText(page), 'no text selected after the long drag').toBe('');

    // Double click: back to 50:50.
    await separator.dblclick();
    const reset = await expectSplit(page, {
      orientation: 'horizontal',
      first: 'pdf',
      pdfRatio: 50,
    });
    expect(Math.abs(reset.pdf.width - reset.text.width)).toBeLessThanOrEqual(2);
  },
);

test(
  'DOCVIEW-01-AC06 the splitter moves by 5 with the split-axis arrows, Home/End go to the limits and Enter resets',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await openOwnerDocument(page, workspaceFactory, 'docview01-ac06', { viewport: DESKTOP });
    const separator = viewerUi.separator(page);
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: 50 });

    await pressOnSeparator(page, 'ArrowRight');
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: 55 });
    // The keyboard focus indicator follows qz-focus-ring (2px solid outline on :focus-visible).
    await expect
      .poll(() =>
        separator.evaluate((el) => {
          const style = getComputedStyle(el);
          return `${el.matches(':focus-visible')} ${style.outlineStyle} ${style.outlineWidth}`;
        }),
      )
      .toBe('true solid 2px');
    await separator.press('ArrowLeft');
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: 50 });

    await separator.press('End');
    const atMax = await measureSplit(page, 'horizontal');
    expect(atMax.valueMax).toBeGreaterThan(55);
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: atMax.valueMax });
    await separator.press('Home');
    const atMin = await measureSplit(page, 'horizontal');
    expect(atMin.valueMin).toBeLessThan(45);
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: atMin.valueMin });
    await separator.press('Enter');
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: 50 });

    // 상하: ↓/↑ move the bar, → is ignored.
    await chooseOrientation(page, 'vertical');
    await expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
    await pressOnSeparator(page, 'ArrowDown');
    await expectSplit(page, { orientation: 'vertical', first: 'pdf', pdfRatio: 55 });
    await separator.press('ArrowUp');
    await expectSplit(page, { orientation: 'vertical', first: 'pdf', pdfRatio: 50 });
    await separator.press('ArrowUp');
    await expectSplit(page, { orientation: 'vertical', first: 'pdf', pdfRatio: 45 });
    await separator.press('ArrowRight');
    await expectSplit(page, { orientation: 'vertical', first: 'pdf', pdfRatio: 45 });
  },
);

/** WebKit's messages for a load cancelled by a navigation (not an app error). */
const CANCELLED_LOAD =
  /cannot load .* due to access control checks|Load failed|NetworkError|network connection was lost|cancelled/i;

const PDF_60: ViewerSettings = { ...DEFAULT_VIEWER_SETTINGS, pdfRatio: 60 };

test(
  'DOCVIEW-01-AC07 switching 좌우 ↔ 상하 keeps the PDF share, the page and the selected block',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await openOwnerDocument(page, workspaceFactory, 'docview01-ac07', {
      viewport: DESKTOP,
      settings: PDF_60,
    });
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: 60 });
    await viewerUi.outlineItem(page, CH2_S2.title).click();
    await expectPdfAt(page, CH2_S2.page, CH2_S2.title);
    await expectCurrentBlock(page, CH2_S2_FIRST.text, 'block chosen before the switch');

    await chooseOrientation(page, 'vertical');
    await expectSplit(page, { orientation: 'vertical', first: 'pdf', pdfRatio: 60 });
    await expectPdfAt(page, CH2_S2.page, 'page kept after 상하');
    await expectCurrentBlock(page, CH2_S2_FIRST.text, 'block kept after 상하');
    await expectCurrentPageGroup(page, CH2_S2.page, 'page groups after 상하');
    await expect(viewerUi.highlight(page)).toBeInViewport();

    await chooseOrientation(page, 'horizontal');
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: 60 });
    await expectPdfAt(page, CH2_S2.page, 'page kept after 좌우');
    await expectCurrentBlock(page, CH2_S2_FIRST.text, 'block kept after 좌우');
    await expectCurrentPageGroup(page, CH2_S2.page, 'page groups after 좌우');
  },
);

test(
  'DOCVIEW-01-AC08 위치 바꾸기 swaps the panes from the keyboard in both orientations and keeps each pane its size',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await openOwnerDocument(page, workspaceFactory, 'docview01-ac08', {
      viewport: DESKTOP,
      settings: PDF_60,
    });
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: 60 });
    const swap = viewerUi.swapButton(page);

    await swap.focus();
    await swap.press('Enter');
    const swapped = await expectSplit(page, {
      orientation: 'horizontal',
      first: 'text',
      pdfRatio: 60,
    });
    expect(swapped.valueNow, 'aria-valuenow is the new first pane (변환본)').toBe(40);
    await expect(swap).toBeFocused();
    await expect(
      viewerUi
        .liveRegions(page)
        .filter({ hasText: /변환본이 왼쪽.*원본이 오른쪽|converted.*left.*original.*right/i }),
    ).toHaveCount(1);

    // DOC-02 sync still works in the swapped layout: a block click moves the PDF and highlights.
    await expect(viewerUi.currentPage(page)).not.toHaveValue(String(CHLORINE.parts[0]?.page));
    await viewerUi
      .textBlock(page, snippet(CHLORINE.text))
      .getByText(snippet(CHLORINE.text))
      .click();
    await expectPdfAt(page, CHLORINE.parts[0]?.page ?? 4, 'block click in the swapped layout');
    await expect(viewerUi.highlight(page)).toBeVisible();

    await chooseOrientation(page, 'vertical');
    await expectSplit(page, { orientation: 'vertical', first: 'text', pdfRatio: 60 });
    await swap.focus();
    await swap.press('Enter');
    await expectSplit(page, { orientation: 'vertical', first: 'pdf', pdfRatio: 60 });
    await expect(swap).toBeFocused();
    await expect(
      viewerUi
        .liveRegions(page)
        .filter({ hasText: /원본이 위.*변환본이 아래|original.*top.*converted.*bottom/i }),
    ).toHaveCount(1);
  },
);

/** Drags `pane`'s header handle with the mouse onto the other pane and drops it there. */
async function mouseSwap(page: Page, pane: PaneId): Promise<void> {
  const other: PaneId = pane === 'pdf' ? 'text' : 'pdf';
  const target = viewerUi.pane(page, other);
  await mouseDragStart(page, viewerUi.handle(page, pane), center(await boxOf(target)));
  await expectDropHint(page, target);
  await page.mouse.up();
  await expect(viewerUi.dropHint(page)).toBeHidden();
}

test(
  'DOCVIEW-01-AC09 dragging a pane header onto the other pane swaps them, Escape cancels, and touch works too',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await openOwnerDocument(page, workspaceFactory, 'docview01-ac09', { viewport: DESKTOP });
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: 50 });

    // Mouse, 좌우: 원본 dropped on 변환본 → 원본 on the right.
    await mouseSwap(page, 'pdf');
    await expectSplit(page, { orientation: 'horizontal', first: 'text', pdfRatio: 50 });

    // Escape while dragging cancels: releasing afterwards changes nothing.
    const textPane = viewerUi.pane(page, 'text');
    await mouseDragStart(page, viewerUi.handle(page, 'pdf'), center(await boxOf(textPane)));
    await expectDropHint(page, textPane);
    await page.keyboard.press('Escape');
    await expect(viewerUi.dropHint(page)).toBeHidden();
    await page.mouse.up();
    await expectSplit(page, { orientation: 'horizontal', first: 'text', pdfRatio: 50 });

    // Released outside the viewer (the page margin beyond the other pane): no hint, no swap.
    await mouseDragStart(page, viewerUi.handle(page, 'pdf'), {
      x: 4,
      y: center(await boxOf(textPane)).y,
    });
    await expect(viewerUi.dropHint(page)).toBeHidden();
    await page.mouse.up();
    await expectSplit(page, { orientation: 'horizontal', first: 'text', pdfRatio: 50 });

    // 상하 (변환본 on top after the swap above): mouse puts 원본 back on top …
    await chooseOrientation(page, 'vertical');
    await expectSplit(page, { orientation: 'vertical', first: 'text', pdfRatio: 50 });
    await mouseSwap(page, 'pdf');
    await expectSplit(page, { orientation: 'vertical', first: 'pdf', pdfRatio: 50 });

    // … and a touch drag of the 변환본 handle onto 원본 moves 변환본 up.
    const pdfPane = viewerUi.pane(page, 'pdf');
    const touch = await touchDragStart(
      page,
      viewerUi.handle(page, 'text'),
      center(await boxOf(pdfPane)),
    );
    await expectDropHint(page, pdfPane);
    await touch.end();
    await expect(viewerUi.dropHint(page)).toBeHidden();
    await expectSplit(page, { orientation: 'vertical', first: 'text', pdfRatio: 50 });

    // Touch in 좌우 as well: 원본 handle onto 변환본 → 원본 first again.
    await chooseOrientation(page, 'horizontal');
    await expectSplit(page, { orientation: 'horizontal', first: 'text', pdfRatio: 50 });
    const touchBack = await touchDragStart(
      page,
      viewerUi.handle(page, 'pdf'),
      center(await boxOf(viewerUi.pane(page, 'text'))),
    );
    await expectDropHint(page, viewerUi.pane(page, 'text'));
    await touchBack.end();
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: 50 });
  },
);

test(
  'DOCVIEW-01-AC10 settings persist in this browser only (localStorage), across reloads and documents, and bad or blocked storage falls back to defaults',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(3 * JOB_TIMEOUT_MS + 120_000);
    const { owner, workspaceId, path } = await openOwnerDocument(
      page,
      workspaceFactory,
      'docview01-ac10',
      { viewport: TALL },
    );
    const otherDocument = await uploadReadyBook(owner, workspaceId, 'book-en');
    const errors: string[] = [];
    // WebKit reports loads cut off by our own reload/goto (cancelled fetches, prefetches, worker
    // scripts) as page errors; only that navigation noise is ignored, everything else counts.
    let navigating = false;
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigating = true;
    });
    page.on('domcontentloaded', () => {
      navigating = false;
    });
    page.on('pageerror', (error) => {
      const text = `${error.name}: ${error.message}`;
      if (navigating && CANCELLED_LOAD.test(text)) return;
      errors.push(text);
    });
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: 50 });

    // Change everything: outline, 상하, swap, ratio (변환본 first: ↓×3 → 변환본 65 / 원본 35), 변환본.
    const urlBefore = page.url();
    const keysBefore = await storageKeys(page);
    const api = recordApiRequests(page);
    await collapseOutline(page);
    await chooseOrientation(page, 'vertical');
    await viewerUi.swapButton(page).click();
    await expectSplit(page, { orientation: 'vertical', first: 'text', pdfRatio: 50 });
    await pressOnSeparator(page, 'ArrowDown');
    await viewerUi.separator(page).press('ArrowDown');
    await viewerUi.separator(page).press('ArrowDown');
    await expectSplit(page, { orientation: 'vertical', first: 'text', pdfRatio: 35 });
    await chooseMode(page, 'text');
    await expectSinglePane(page, 'text');
    api.stop();
    expect(api.urls, 'changing view settings sends no API request').toEqual([]);
    expect(page.url(), 'the address (query included) is unchanged').toBe(urlBefore);
    const expected: ViewerSettings = {
      mode: 'text',
      orientation: 'vertical',
      order: 'text-first',
      pdfRatio: 35,
      outlineOpen: false,
    };
    await expect.poll(() => readViewerSettings(page)).toEqual(expected);
    const added = (await storageKeys(page)).filter((key) => !keysBefore.includes(key));
    expect(added, 'settings live under one localStorage key').toEqual([VIEWER_SETTINGS_KEY]);

    // Reload, then another document of the workspace: the same settings apply.
    for (const target of [path, documentPath(workspaceId, otherDocument)]) {
      if (target === path) await page.reload();
      else await page.goto(target);
      await expect(viewerUi.mode(page, 'text')).toBeChecked();
      await expectSinglePane(page, 'text');
      await expect(viewerUi.expandOutline(page)).toHaveAttribute('aria-expanded', 'false');
      await expect(viewerUi.outlinePanel(page)).toBeHidden();
    }
    // 함께 보기 brings back 상하 · 변환본 first · 원본 35%, outline still collapsed; kept on reload.
    await chooseMode(page, 'both');
    await expectSplit(page, { orientation: 'vertical', first: 'text', pdfRatio: 35 });
    await page.reload();
    await expect(viewerUi.mode(page, 'both')).toBeChecked();
    await expectSplit(page, { orientation: 'vertical', first: 'text', pdfRatio: 35 });
    await expect(viewerUi.outlinePanel(page)).toBeHidden();
    await expect.poll(() => readViewerSettings(page)).toEqual({ ...expected, mode: 'both' });

    // Broken JSON: defaults, no error.
    await writeViewerSettingsRaw(page, '{"mode":"pdf",');
    await page.reload();
    await expect(viewerUi.mode(page, 'both')).toBeChecked();
    await expect(viewerUi.collapseOutline(page)).toHaveAttribute('aria-expanded', 'true');
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: 50 });
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);

    // Out-of-range / unknown values: only those fall back (mode → both, pdfRatio 5 → 20).
    await writeViewerSettingsRaw(
      page,
      JSON.stringify({
        mode: 'grid',
        orientation: 'vertical',
        order: 'text-first',
        pdfRatio: 5,
        outlineOpen: false,
        theme: 'unknown',
      }),
    );
    await page.reload();
    await expect(viewerUi.mode(page, 'both')).toBeChecked();
    await expect(viewerUi.outlinePanel(page)).toBeHidden();
    await expectSplit(page, { orientation: 'vertical', first: 'text', pdfRatio: 20 });
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);

    // Storage that throws: the default layout opens and settings still change on this page.
    await breakBrowserStorage(page);
    await page.reload();
    await expect(viewerUi.mode(page, 'both')).toBeChecked();
    await expect(viewerUi.collapseOutline(page)).toHaveAttribute('aria-expanded', 'true');
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: 50 });
    await chooseMode(page, 'pdf');
    await expectSinglePane(page, 'pdf');
    await chooseMode(page, 'both');
    await chooseOrientation(page, 'vertical');
    await expectSplit(page, { orientation: 'vertical', first: 'pdf', pdfRatio: 50 });
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    expect(errors, 'no uncaught page errors').toEqual([]);
  },
);

test.describe('narrow, tablet and desktop widths', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test(
    'DOCVIEW-01-AC11 narrow screens show one pane with 원본/변환본 and a full-height outline, tablets overlay the outline, and nothing narrow is saved',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const saved: ViewerSettings = {
        mode: 'both',
        orientation: 'vertical',
        order: 'text-first',
        pdfRatio: 50,
        outlineOpen: true,
      };
      const { path } = await openOwnerDocument(page, workspaceFactory, 'docview01-ac11', {
        settings: saved,
      });

      // Narrow (390px, touch): one pane, starting with 원본; only 원본/변환본 in "보기 선택".
      const switchButtons = viewerUi.narrowSwitch(page).getByRole('button');
      await expect(switchButtons).toHaveCount(2);
      await expect(viewerUi.narrowView(page, 'pdf')).toHaveAttribute('aria-pressed', 'true');
      await expect(viewerUi.narrowView(page, 'text')).toHaveAttribute('aria-pressed', 'false');
      await expect(viewerUi.pane(page, 'pdf')).toBeVisible();
      await expect(viewerUi.pane(page, 'text')).toBeHidden();
      await expect(viewerUi.separator(page)).toBeHidden();
      await expect(viewerUi.modeGroup(page)).toBeHidden();
      await expect(viewerUi.orientationGroup(page)).toBeHidden();
      await expect(viewerUi.swapButton(page)).toBeHidden();
      await expect(viewerUi.outlinePanel(page)).toBeHidden();

      await viewerUi.narrowView(page, 'text').tap();
      await expect(viewerUi.narrowView(page, 'text')).toHaveAttribute('aria-pressed', 'true');
      await expect(viewerUi.pane(page, 'text')).toBeVisible();
      await expect(viewerUi.pane(page, 'pdf')).toBeHidden();

      // 목차 opens a full-height panel; a section closes it and shows that page in 원본.
      await viewerUi.narrowOutlineButton(page).tap();
      const panel = viewerUi.outlinePanel(page);
      await expect(panel).toBeVisible();
      const viewport = page.viewportSize() ?? { width: 390, height: 844 };
      expect((await boxOf(panel)).height, 'full-height panel').toBeGreaterThanOrEqual(
        viewport.height - 2,
      );
      await viewerUi.outlineItem(page, CH2_S2.title).tap();
      await expect(panel).toBeHidden();
      await expect(viewerUi.narrowView(page, 'pdf')).toHaveAttribute('aria-pressed', 'true');
      await expect(viewerUi.pane(page, 'pdf')).toBeVisible();
      await expectPdfAt(page, CH2_S2.page, 'section chosen on a narrow screen');
      expect(await readViewerSettings(page), 'narrow switching is not saved').toEqual(saved);

      // Tablet (834px): the saved 상하 · 변환본 first layout; the outline starts collapsed even
      // though it is saved open, overlays the panes, and collapses after choosing a section.
      await page.setViewportSize({ width: 834, height: 1112 });
      await page.goto(path);
      await expect(viewerUi.mode(page, 'both')).toBeChecked();
      const tablet = await expectSplit(page, {
        orientation: 'vertical',
        first: 'text',
        pdfRatio: 50,
      });
      await expect(viewerUi.expandOutline(page)).toHaveAttribute('aria-expanded', 'false');
      await expect(panel).toBeHidden();
      await viewerUi.expandOutline(page).click();
      await expect(panel).toBeVisible();
      const panelBox = await boxOf(panel);
      expect(overlaps(panelBox, tablet.text, 20), 'the panel overlays the panes').toBe(true);
      const after = await measureSplit(page, 'vertical');
      expect(
        Math.abs(after.text.x - tablet.text.x),
        'the panes do not move aside on a tablet',
      ).toBeLessThanOrEqual(2);
      await viewerUi.outlineItem(page, CH1_S2.title).click();
      await expect(panel).toBeHidden();
      await expect(viewerUi.expandOutline(page)).toHaveAttribute('aria-expanded', 'false');
      await expectPdfAt(page, CH1_S2.page, 'section chosen on a tablet');
      expect(await readViewerSettings(page), 'tablet outline toggling is not saved').toEqual(saved);

      // Desktop again (no reload): the saved settings are all still there.
      await page.setViewportSize(DESKTOP);
      await expect(viewerUi.mode(page, 'both')).toBeChecked();
      await expect(viewerUi.orientation(page, 'vertical')).toBeChecked();
      await expectSplit(page, { orientation: 'vertical', first: 'text', pdfRatio: 50 });
      expect(await readViewerSettings(page)).toEqual(saved);
    },
  );
});

test.describe('shared-link guest', () => {
  test(
    'DOCVIEW-01-AC12 a signed-out guest gets the same outline panel, modes, swap and splitter, remembered on reload, without editing UI or API calls',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await page.setViewportSize(DESKTOP);
      const owner = await workspaceFactory.member('docview01-ac12');
      const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('docview01-ac12'));
      const link = await createShareLink(owner, ws.id);
      await seedSharedContent(owner, ws.id);
      const session = await ShareSession.open(link.id, link.secret);
      const [doc] = (await session.workspace()).documents;

      await openShareWithSecret(page, link.id, link.secret);
      await expect(sharedUi.readOnlyNotice(page)).toBeVisible();
      await expectFragmentRemoved(page, link.id);
      await sharedUi.documentLink(page, doc?.title ?? '?').click();
      await expect(viewerUi.settingsBar(page)).toBeVisible();

      // Defaults as on DOC-02.
      const panel = viewerUi.outlinePanel(page);
      await expect(panel).toBeVisible();
      await expect(viewerUi.mode(page, 'both')).toBeChecked();
      await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: 50 });
      await expect(sharedUi.forbiddenControls(page)).toHaveCount(0);

      // Viewport fit (DOCVIEW-X): the split area's height must not depend on the sidebar column
      // beside it. A sidebar far taller than the viewer leaves the measurement and the panes as
      // they were, stable over several frames (no ResizeObserver shrink loop to the min height).
      const [fitBefore] = await sampleViewerFit(page, 1);
      expect(fitBefore?.chrome, 'viewer fit is measured').not.toBe('');
      await page.evaluate(() => {
        const tall = document.createElement('div');
        tall.dataset.e2eTallSidebar = '';
        tall.style.height = '3000px';
        document.querySelector('main aside')?.append(tall);
      });
      await expect(page.locator('main aside [data-e2e-tall-sidebar]')).toHaveCount(1);
      for (const fit of await sampleViewerFit(page)) {
        expect(fit.chrome, 'chrome unchanged by a tall sidebar').toBe(fitBefore?.chrome);
        expect(
          Math.abs(fit.areaHeight - (fitBefore?.areaHeight ?? 0)),
          'split area height unchanged by a tall sidebar',
        ).toBeLessThanOrEqual(1);
        expect(fit.areaHeight, 'split area above its 28rem min height').toBeGreaterThan(448);
      }
      await page.evaluate(() => document.querySelector('[data-e2e-tall-sidebar]')?.remove());
      await expectFitsViewport(page);

      const documentUrl = page.url();
      const api = recordApiRequests(page);
      await viewerUi.collapseOutline(page).click();
      await expect(panel).toBeHidden();
      await chooseMode(page, 'pdf');
      await expectSinglePane(page, 'pdf');
      await expect(sharedUi.forbiddenControls(page)).toHaveCount(0);
      await chooseMode(page, 'both');
      await viewerUi.swapButton(page).focus();
      await viewerUi.swapButton(page).press('Enter');
      await expectSplit(page, { orientation: 'horizontal', first: 'text', pdfRatio: 50 });
      await pressOnSeparator(page, 'ArrowRight');
      await viewerUi.separator(page).press('ArrowRight');
      await expectSplit(page, { orientation: 'horizontal', first: 'text', pdfRatio: 40 });
      api.stop();
      expect(api.urls, 'changing view settings sends no API request').toEqual([]);
      await expectUrl(page, (url) => url.href === documentUrl, 'the address is unchanged');

      await page.reload();
      await expect(viewerUi.settingsBar(page)).toBeVisible();
      await expect(viewerUi.mode(page, 'both')).toBeChecked();
      await expect(viewerUi.expandOutline(page)).toHaveAttribute('aria-expanded', 'false');
      await expect(panel).toBeHidden();
      await expectSplit(page, { orientation: 'horizontal', first: 'text', pdfRatio: 40 });
      for (const mode of ['text', 'both'] as const) {
        await chooseMode(page, mode);
        await expect(sharedUi.forbiddenControls(page)).toHaveCount(0);
      }
      expect(await readViewerSettings(page)).toEqual({
        mode: 'both',
        orientation: 'horizontal',
        order: 'text-first',
        pdfRatio: 40,
        outlineOpen: false,
      });
    },
  );
});
