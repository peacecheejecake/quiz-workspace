// DOCVIEW-01 — PDF 열람 보기 설정 (docs/screens/documents-viewer-layout.md): UI label contract,
// browser-storage helpers and layout measurements for the DOC-02 document screen and the WS-VIEW-01
// shared document view. Korean first, English accepted (AGENTS.md §5); a deliberate label change
// is a one-place edit here.
//
// UI contract (UX10-DOC): the overlay contains the outline toggle, independent 원본 and 변환본
// checkboxes, and, for desktop/tablet with both selected, the split direction and swap controls.
// A fresh browser defaults to 원본; at least one checkbox remains selected.
//   - outline panel: a non-modal FloatingSidePanel = role=dialog named "목차" (docked left of the
//     split area on desktop, overlay on tablet, full-height on narrow screens); its header has a
//     second "목차 접기" button. The existing tree "목차" lives inside it.
//   - panes: region "PDF 원본" and region "변환본 텍스트" (the whole pane, header included); each
//     pane header has a drag handle button "원본 위치 옮기기" / "변환본 위치 옮기기"; while one is
//     dragged the other pane shows "여기에 놓아 위치 바꾸기" with a dashed border.
//   - splitter: role=separator named "원본과 변환본 크기 조절", aria-orientation vertical for 좌우
//     (horizontal for 상하), aria-valuenow = the FIRST pane's percentage, aria-valuetext
//     "원본 n%, 변환본 m%".
//   - a polite live region (aria-live or role=status) announces a swap ("변환본이 왼쪽, 원본이
//     오른쪽에 있습니다", 상하: 위/아래).
//   - narrow screens (< 768px): both selected panes are stacked vertically and share a splitter.
//   - the PDF toolbar is part of the overlay; the pane contains the continuous PDF pages and
//     source highlight. The converted-text pane contains page groups and question cards.
//
// Settings live only in `localStorage["quiz.documentViewer.v1"]` as JSON
// `{mode: both|pdf|text, orientation: horizontal|vertical, order: pdf-first|text-first,
// pdfRatio: 20…80, outlineOpen: boolean}` (orientation horizontal = 좌우). Each test has its own
// browser context, so storage never leaks between tests; seeds go in through init scripts.
//
// Touch drags: Playwright has no touch-drag API, so touchDrag() dispatches synthetic PointerEvents
// (pointerType 'touch') down → moves → up on the pressed element, the way a real touch pointer is
// implicitly captured by its pointerdown target. They use pointerId 1 (the always-active mouse
// pointer id in Chromium and WebKit) so an implementation calling setPointerCapture() on them does
// not throw NotFoundError.
import { expect, type Locator, type Page } from '@playwright/test';

export const VIEWER_SETTINGS_KEY = 'quiz.documentViewer.v1';

export type ViewMode = 'both' | 'pdf' | 'text';
/** horizontal = 좌우 (side by side), vertical = 상하 (stacked). */
export type SplitOrientation = 'horizontal' | 'vertical';
export type PaneId = 'pdf' | 'text';

export interface ViewerSettings {
  readonly mode: ViewMode;
  readonly orientation: SplitOrientation;
  readonly order: 'pdf-first' | 'text-first';
  readonly pdfRatio: number;
  readonly outlineOpen: boolean;
}

export const DEFAULT_VIEWER_SETTINGS: ViewerSettings = {
  mode: 'pdf',
  orientation: 'horizontal',
  order: 'pdf-first',
  pdfRatio: 50,
  outlineOpen: true,
};

const ORIENTATION_NAMES: Readonly<Record<SplitOrientation, RegExp>> = {
  horizontal: /^(좌우로 나누기|좌우|left and right|split horizontally|horizontal)$/i,
  vertical: /^(상하로 나누기|상하|top and bottom|split vertically|vertical|stacked)$/i,
};

const PANE_NAMES: Readonly<Record<PaneId, RegExp>> = {
  pdf: /^(PDF 원본|original PDF)$/i,
  text: /^(변환본 텍스트|converted text)$/i,
};

const HANDLE_NAMES: Readonly<Record<PaneId, RegExp>> = {
  pdf: /^(원본 위치 옮기기|move (the )?original( pane)?)$/i,
  text: /^(변환본 위치 옮기기|move (the )?converted( text)?( pane)?)$/i,
};

const OUTLINE_EXPAND = /^(목차 펼치기|show outline|expand outline)$/i;
const OUTLINE_COLLAPSE = /^(목차 접기|hide outline|collapse outline)$/i;

export const viewerUi = {
  settingsBar: (page: Page) => page.getByRole('group', { name: /^(보기 설정|view settings)$/i }),
  /** The bar's outline toggle in either state (aria-expanded tells which). */
  outlineToggle: (page: Page) =>
    viewerUi.settingsBar(page).getByRole('button', {
      name: new RegExp(`${OUTLINE_EXPAND.source}|${OUTLINE_COLLAPSE.source}`, 'i'),
    }),
  expandOutline: (page: Page) =>
    viewerUi.settingsBar(page).getByRole('button', { name: OUTLINE_EXPAND }),
  collapseOutline: (page: Page) =>
    viewerUi.settingsBar(page).getByRole('button', { name: OUTLINE_COLLAPSE }),
  /** The docked / overlay / full-height outline panel (non-modal FloatingSidePanel). */
  outlinePanel: (page: Page) =>
    page.getByRole('dialog', { name: /^(목차|outline|table of contents)$/i }),
  outlineItem: (page: Page, title: string) =>
    viewerUi.outlinePanel(page).getByRole('treeitem', { name: title, exact: true }),
  modeGroup: (page: Page) =>
    viewerUi.settingsBar(page).getByRole('group', { name: /^(보기 선택|choose view)$/i }),
  mode: (page: Page, mode: ViewMode) =>
    viewerUi.modeGroup(page).getByRole('checkbox', {
      name: mode === 'pdf' ? /^(원본|original)$/i : /^(변환본|converted)$/i,
    }),
  orientationGroup: (page: Page) =>
    viewerUi.settingsBar(page).getByRole('radiogroup', {
      name: /^(분할 방향|split direction|split orientation)$/i,
    }),
  orientation: (page: Page, orientation: SplitOrientation) =>
    viewerUi.orientationGroup(page).getByRole('radio', { name: ORIENTATION_NAMES[orientation] }),
  swapButton: (page: Page) =>
    viewerUi.settingsBar(page).getByRole('button', {
      name: /^(원본과 변환본 위치 바꾸기|위치 바꾸기|swap( panes| positions)?)$/i,
    }),
  separator: (page: Page) =>
    page.getByRole('separator', { name: /^(원본과 변환본 크기 조절|크기 조절|resize( panes)?)$/i }),
  pane: (page: Page, pane: PaneId) => page.getByRole('region', { name: PANE_NAMES[pane] }),
  handle: (page: Page, pane: PaneId) => page.getByRole('button', { name: HANDLE_NAMES[pane] }),
  dropHint: (page: Page) => page.getByText(/여기에 놓아 위치 바꾸기|drop (here )?to swap/i),
  liveRegions: (page: Page) =>
    page.locator('[aria-live="polite"], [aria-live="assertive"], [role="status"]'),
  /** Narrow screens: the one-pane switch "보기 선택" (aria-pressed buttons 원본 / 변환본). */
  narrowSwitch: (page: Page) => page.getByRole('group', { name: /^(보기 선택|choose view)$/i }),
  narrowView: (page: Page, pane: PaneId) =>
    viewerUi.narrowSwitch(page).getByRole('checkbox', {
      name: pane === 'pdf' ? /^(원본|original)$/i : /^(변환본|converted)$/i,
    }),
  narrowOutlineButton: (page: Page) =>
    viewerUi
      .settingsBar(page)
      .getByRole('button', { name: /^(목차 펼치기|목차 접기|show outline|hide outline)$/i }),
  /** Inside the PDF pane (DOC-02): the "현재 페이지" field and the labelled source highlight. */
  currentPage: (page: Page) => page.getByLabel(/현재 페이지|current page/i),
  highlight: (page: Page) =>
    viewerUi.pane(page, 'pdf').getByLabel(/원문 위치|출처 위치|source (location|highlight)/i),
  /** The converted-text pane's current block (aria-current="true", DOC-02). */
  currentBlock: (page: Page) => viewerUi.pane(page, 'text').locator('[aria-current="true"]'),
  textBlock: (page: Page, text: string) =>
    viewerUi.pane(page, 'text').getByRole('article').filter({ hasText: text }),
};

// ---------------------------------------------------------------------------------------------
// Browser storage (localStorage only; one setting per browser)
// ---------------------------------------------------------------------------------------------

/**
 * Puts `value` (an object is stored as JSON, a string as-is) under the settings key once, before
 * the app's first script on the next navigation. Later reloads keep whatever the app stored then
 * (the seed is guarded by a sessionStorage flag of this tab).
 */
export async function seedViewerSettings(
  page: Page,
  value: Partial<ViewerSettings> | Record<string, unknown> | string,
): Promise<void> {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  await page.addInitScript(
    ({ key, raw: stored }) => {
      try {
        if (window.sessionStorage.getItem('e2e-docview-seeded') === '1') return;
        window.localStorage.setItem(key, stored);
        window.sessionStorage.setItem('e2e-docview-seeded', '1');
      } catch {
        // Storage disabled on purpose by breakBrowserStorage(): nothing to seed.
      }
    },
    { key: VIEWER_SETTINGS_KEY, raw },
  );
}

/** Overwrites the stored settings now (on the app's origin); takes effect on the next load. */
export async function writeViewerSettingsRaw(page: Page, raw: string): Promise<void> {
  await page.evaluate(({ key, value }) => window.localStorage.setItem(key, value), {
    key: VIEWER_SETTINGS_KEY,
    value: raw,
  });
}

/** Every later navigation of this page gets a Storage whose reads and writes throw. */
export async function breakBrowserStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const deny = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    Storage.prototype.getItem = deny;
    Storage.prototype.setItem = deny;
    Storage.prototype.removeItem = deny;
  });
}

/** The parsed stored settings, `null` when absent; `undefined` keys are reported as missing. */
export async function readViewerSettings(page: Page): Promise<unknown> {
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), VIEWER_SETTINGS_KEY);
  return raw === null ? null : (JSON.parse(raw) as unknown);
}

/** Every localStorage key of the page's origin (settings must live under one key only). */
export async function storageKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(window.localStorage));
}

// ---------------------------------------------------------------------------------------------
// Network: settings never reach the server
// ---------------------------------------------------------------------------------------------

/** Records API requests (`/api/` paths on any origin) from now on; stop() detaches. */
export function recordApiRequests(page: Page): { readonly urls: string[]; stop(): void } {
  const urls: string[] = [];
  const onRequest = (request: { url(): string; method(): string }) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) urls.push(`${request.method()} ${url.pathname}`);
  };
  page.on('request', onRequest);
  return { urls, stop: () => page.off('request', onRequest) };
}

// ---------------------------------------------------------------------------------------------
// Layout measurement
// ---------------------------------------------------------------------------------------------

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no layout box (hidden or detached)');
  return box;
}

export function center(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Two boxes overlap by more than `tolerance` px on both axes. */
export function overlaps(a: Box, b: Box, tolerance = 1): boolean {
  const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return x > tolerance && y > tolerance;
}

export interface SplitMeasure {
  readonly ariaOrientation: string | null;
  readonly valueNow: number;
  readonly valueMin: number;
  readonly valueMax: number;
  readonly valueText: string;
  readonly pdf: Box;
  readonly text: Box;
  /** Which pane comes first on the split axis. */
  readonly first: PaneId;
  /** The PDF pane's share of both panes along the split axis, in %. */
  readonly pdfPercent: number;
}

/** Reads the separator's ARIA values and both pane boxes along the split axis. */
export async function measureSplit(
  page: Page,
  orientation: SplitOrientation,
): Promise<SplitMeasure> {
  const separator = viewerUi.separator(page);
  const [ariaOrientation, now, min, max, text] = await Promise.all([
    separator.getAttribute('aria-orientation', { timeout: 1_000 }),
    separator.getAttribute('aria-valuenow', { timeout: 1_000 }),
    separator.getAttribute('aria-valuemin', { timeout: 1_000 }),
    separator.getAttribute('aria-valuemax', { timeout: 1_000 }),
    separator.getAttribute('aria-valuetext', { timeout: 1_000 }),
  ]);
  const pdf = await boxOf(viewerUi.pane(page, 'pdf'));
  const textBox = await boxOf(viewerUi.pane(page, 'text'));
  const size = (b: Box) => (orientation === 'horizontal' ? b.width : b.height);
  const start = (b: Box) => (orientation === 'horizontal' ? b.x : b.y);
  return {
    ariaOrientation,
    valueNow: Number(now),
    valueMin: Number(min),
    valueMax: Number(max),
    valueText: text ?? '',
    pdf,
    text: textBox,
    first: start(pdf) < start(textBox) ? 'pdf' : 'text',
    pdfPercent: (100 * size(pdf)) / (size(pdf) + size(textBox)),
  };
}

/** Allowed gap between a pane's measured share and the expected ratio (pane chrome, separator). */
export const RATIO_TOLERANCE = 2.5;

/**
 * Waits until both panes are laid out as expected: split axis, first pane, the PDF pane's measured
 * share of the two panes, and the separator's ARIA (orientation, valuenow = first pane %,
 * valuetext "원본 n%, 변환본 m%"). Returns the measurement.
 */
export async function expectSplit(
  page: Page,
  expected: { orientation: SplitOrientation; first: PaneId; pdfRatio: number },
): Promise<SplitMeasure> {
  let last: SplitMeasure | undefined;
  await expect(async () => {
    const m = await measureSplit(page, expected.orientation);
    last = m;
    const frontRatio = expected.first === 'pdf' ? expected.pdfRatio : 100 - expected.pdfRatio;
    expect(m.ariaOrientation, 'separator aria-orientation').toBe(
      expected.orientation === 'horizontal' ? 'vertical' : 'horizontal',
    );
    expect(m.first, 'first pane on the split axis').toBe(expected.first);
    // Panes follow each other on the split axis without overlapping.
    const [a, b] = m.first === 'pdf' ? [m.pdf, m.text] : [m.text, m.pdf];
    if (expected.orientation === 'horizontal') {
      expect(a.x + a.width, 'first pane ends before the second').toBeLessThanOrEqual(b.x + 1);
    } else {
      expect(a.y + a.height, 'first pane ends above the second').toBeLessThanOrEqual(b.y + 1);
    }
    expect(m.valueNow, 'separator aria-valuenow (first pane %)').toBe(frontRatio);
    expect(Math.abs(m.pdfPercent - expected.pdfRatio), 'PDF pane share').toBeLessThanOrEqual(
      RATIO_TOLERANCE,
    );
    expectValueText(m.valueText, expected.pdfRatio);
  }).toPass({ timeout: 10_000 });
  if (!last) throw new Error('split not measured');
  return last;
}

/** aria-valuetext names both panes with their own share: "원본 60%, 변환본 40%". */
export function expectValueText(valueText: string, pdfRatio: number): void {
  const match =
    /원본\s*(\d+)\s*%.*변환본\s*(\d+)\s*%/.exec(valueText) ??
    /original\s*(\d+)\s*%.*converted\s*(\d+)\s*%/i.exec(valueText);
  expect(match, `aria-valuetext names both panes: "${valueText}"`).not.toBeNull();
  expect(Number(match?.[1]), 'valuetext PDF %').toBe(pdfRatio);
  expect(Number(match?.[2]), 'valuetext converted-text %').toBe(100 - pdfRatio);
}

/** Exactly one pane is shown and the split controls are gone (원본 / 변환본 modes). */
export async function expectSinglePane(page: Page, shown: PaneId): Promise<void> {
  const hidden: PaneId = shown === 'pdf' ? 'text' : 'pdf';
  await expect(viewerUi.pane(page, shown)).toBeVisible();
  await expect(viewerUi.pane(page, hidden)).toBeHidden();
  await expect(viewerUi.separator(page)).toBeHidden();
  await expect(viewerUi.orientationGroup(page)).toBeHidden();
  await expect(viewerUi.swapButton(page)).toBeHidden();
}

/** The current text selection (dragging a splitter must not select pane text). */
export function selectionText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

// ---------------------------------------------------------------------------------------------
// Pointer drags
// ---------------------------------------------------------------------------------------------

/** Mouse: press on `from`'s centre and move (in steps) to `to`; the button stays pressed. */
export async function mouseDragStart(
  page: Page,
  from: Locator,
  to: { x: number; y: number },
): Promise<void> {
  const start = center(await boxOf(from));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
}

export interface TouchDrag {
  /** Releases the touch where it is (pointerup on the pressed element). */
  end(): Promise<void>;
}

/**
 * Touch: synthetic `pointerType: 'touch'` pointerdown on `from`'s centre, then pointermoves to `to`
 * (all dispatched on the pressed element, as implicit touch capture does). Call end() to release.
 */
export async function touchDragStart(
  page: Page,
  from: Locator,
  to: { x: number; y: number },
): Promise<TouchDrag> {
  const start = center(await boxOf(from));
  const handle = await from.elementHandle();
  if (!handle) throw new Error('touch drag: element not found');
  await handle.evaluate(
    (el, { start: s, to: t }) => {
      const init = (x: number, y: number, buttons: number): PointerEventInit => ({
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        buttons,
        clientX: x,
        clientY: y,
        width: 10,
        height: 10,
        pressure: buttons ? 0.5 : 0,
      });
      el.dispatchEvent(new PointerEvent('pointerdown', init(s.x, s.y, 1)));
      const steps = 12;
      for (let i = 1; i <= steps; i += 1) {
        const x = s.x + ((t.x - s.x) * i) / steps;
        const y = s.y + ((t.y - s.y) * i) / steps;
        el.dispatchEvent(new PointerEvent('pointermove', init(x, y, 1)));
      }
    },
    { start, to },
  );
  return {
    end: async () => {
      await handle.evaluate(
        (el, { t }) => {
          el.dispatchEvent(
            new PointerEvent('pointerup', {
              bubbles: true,
              cancelable: true,
              composed: true,
              pointerId: 1,
              pointerType: 'touch',
              isPrimary: true,
              button: 0,
              buttons: 0,
              clientX: t.x,
              clientY: t.y,
            }),
          );
        },
        { t: to },
      );
      await handle.dispose();
    },
  };
}

/** The drop hint shows inside `target` and it (or an ancestor up to `target`) has a dashed edge. */
export async function expectDropHint(page: Page, target: Locator): Promise<void> {
  const hint = target.getByText(/여기에 놓아 위치 바꾸기|drop (here )?to swap/i);
  await expect(hint).toBeVisible();
  const targetHandle = await target.elementHandle();
  await expect
    .poll(
      () =>
        hint.evaluate((el, root) => {
          for (let node: Element | null = el; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.borderTopStyle === 'dashed' || style.outlineStyle === 'dashed') return true;
            if (node === root) break;
          }
          // The dashed edge may be a sibling overlay of the hint inside the target pane.
          return Array.from((root as Element | null)?.querySelectorAll('*') ?? []).some((n) => {
            const style = getComputedStyle(n);
            return style.borderTopStyle === 'dashed' || style.outlineStyle === 'dashed';
          });
        }, targetHandle),
      { message: 'the drop target shows a dashed border' },
    )
    .toBe(true);
  await targetHandle?.dispose();
}

/** The full-height viewer locks page scrolling while its reading panes scroll independently. */
export async function expectFitsViewport(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).overflow), {
      message: 'the document viewport locks page scrolling',
    })
    .toBe('hidden');
  const pane = page.getByRole('region', { name: PANE_NAMES.pdf });
  const bounds = await boxOf(pane);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 1);
}

export interface ViewerFit {
  /** `--viewer-area-chrome` on the split area (px string), '' before it is measured. */
  readonly chrome: string;
  /** The split area's rendered height. */
  readonly areaHeight: number;
}

/**
 * Reads the viewport-fit measurement `samples` times, one animation frame apart, so a
 * ResizeObserver feedback loop (the area shrinking tick after tick) shows up as differing samples.
 */
export async function sampleViewerFit(page: Page, samples = 4): Promise<ViewerFit[]> {
  return page.evaluate(async (count) => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const read = () => {
      const area = Array.from(document.querySelectorAll<HTMLElement>('[style]')).find(
        (el) => el.style.getPropertyValue('--viewer-area-chrome') !== '',
      );
      return {
        chrome: area?.style.getPropertyValue('--viewer-area-chrome') ?? '',
        areaHeight: area?.getBoundingClientRect().height ?? 0,
      };
    };
    const out = [];
    for (let i = 0; i < count; i += 1) {
      await frame();
      await frame();
      out.push(read());
    }
    return out;
  }, samples);
}
