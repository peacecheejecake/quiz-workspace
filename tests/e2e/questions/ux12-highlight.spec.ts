// UX12-HILITE — 하이라이트 메뉴 선택 유지와 재클릭 닫기, docs/screens/ux12-highlight.md (the tool
// itself: docs/screens/highlights.md). Same synthetic setup as tests/e2e/questions/highlights.spec.ts;
// notes carry answers, so traces, screenshots and videos are off.
import type { Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { noteUi, notePanelPath } from '../fixtures/chapter-notes.ts';
import {
  dragSelect,
  highlightNote,
  highlightUi,
  noteSetup,
  selectionText,
  type NoteSetup,
} from '../fixtures/highlights.ts';
import { expect, NO_VISUAL_ARTIFACTS, test } from '../fixtures/sharing.ts';
import { JOB_TIMEOUT_MS, signInAs } from '../fixtures/test.ts';

test.use({
  storageState: { cookies: [], origins: [] },
  ...NO_VISUAL_ARTIFACTS,
  attachPageTextOnFailure: false,
});
test.describe.configure({ timeout: 6 * JOB_TIMEOUT_MS });

const PHRASE_A = '핵심 용어';
const PHRASE_B = '과정의 순서';
// On the first glyph: the middle of a short mark can be the word gap.
const INSIDE = { position: { x: 4, y: 8 } };

async function openNoteBody(page: Page, s: NoteSetup): Promise<Locator> {
  await signInAs(page, s.owner.user);
  await page.goto(notePanelPath(s.workspaceId, s.ch1));
  const panel = noteUi.panel(page);
  await expect(panel).toBeVisible();
  const body = highlightUi.noteBody(panel);
  await expect(body).toBeVisible();
  return body;
}

/** The note with `PHRASE_A` and `PHRASE_B` highlighted, open in its panel. */
async function twoHighlights(page: Page, s: NoteSetup): Promise<Locator> {
  await highlightNote(s.owner, s.note, 0, 0, PHRASE_A, 'yellow');
  await highlightNote(s.owner, s.note, 0, 1, PHRASE_B, 'blue');
  const body = await openNoteBody(page, s);
  await expect(highlightUi.markWith(body, PHRASE_A)).toHaveCount(1);
  await expect(highlightUi.markWith(body, PHRASE_B)).toHaveCount(1);
  return body;
}

/** Whether the menu's `color` item is the checked one. */
function expectChecked(page: Page, color: 'yellow' | 'blue'): Promise<void> {
  return expect(highlightUi.colorItem(highlightUi.menu(page), color)).toHaveAttribute(
    'aria-checked',
    'true',
  );
}

test(
  'UX12-HILITE-AC01 the selection stays while focus is in the menu and moves between its items',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, 'ux12-hilite-ac01');
    const body = await openNoteBody(page, s);

    await dragSelect(body, PHRASE_A);
    const menu = highlightUi.menu(page);
    await expect(menu).toBeVisible();
    await expect.poll(() => menu.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await expect.poll(() => selectionText(page)).toBe(PHRASE_A);

    // Hovering an item moves focus to it.
    const blue = highlightUi.colorItem(menu, 'blue');
    await blue.hover();
    await expect(blue).toBeFocused();
    await expect.poll(() => selectionText(page)).toBe(PHRASE_A);

    // So does the keyboard.
    await page.keyboard.press('ArrowRight');
    await expect(highlightUi.colorItem(menu, 'pink')).toBeFocused();
    await expect.poll(() => selectionText(page)).toBe(PHRASE_A);

    // It is still the same selection when the menu closes.
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect.poll(() => selectionText(page)).toBe(PHRASE_A);
  },
);

test(
  'UX12-HILITE-AC02 pressing the open highlight again closes the menu, the next press reopens it, another highlight takes the menu over',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, 'ux12-hilite-ac02');
    const body = await twoHighlights(page, s);
    const menu = highlightUi.menu(page);
    const first = highlightUi.markWith(body, PHRASE_A);

    await first.click(INSIDE);
    await expect(menu).toBeVisible();
    await expectChecked(page, 'yellow');

    await first.click(INSIDE);
    await expect(menu).toBeHidden();
    // Nothing reopens it a moment later.
    await page.waitForTimeout(150);
    await expect(menu).toBeHidden();

    await first.click(INSIDE);
    await expect(menu).toBeVisible();
    await expectChecked(page, 'yellow');

    await highlightUi.markWith(body, PHRASE_B).click(INSIDE);
    await expect(menu).toBeVisible();
    await expectChecked(page, 'blue');
  },
);

test.describe('UX12-HILITE-AC02 touch', () => {
  const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 14'];
  test.use(iphone);

  test(
    'UX12-HILITE-AC02 tapping the open highlight again closes the menu and the next tap reopens it',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const s = await noteSetup(workspaceFactory, 'ux12-hilite-ac02-touch');
      const body = await twoHighlights(page, s);
      const menu = highlightUi.menu(page);
      const first = highlightUi.markWith(body, PHRASE_A);
      await first.scrollIntoViewIfNeeded();

      await first.tap(INSIDE);
      await expect(menu).toBeVisible();
      await first.tap(INSIDE);
      await expect(menu).toBeHidden();
      await page.waitForTimeout(150);
      await expect(menu).toBeHidden();
      await first.tap(INSIDE);
      await expect(menu).toBeVisible();
    },
  );
});
