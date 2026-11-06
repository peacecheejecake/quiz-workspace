// UX12-SETTINGS (docs/screens/ux12-settings.md): the 시스템/라이트/다크 control in the user menu
// (quiz-theme cookie, stamped by the server) and the per-browser drag auto-copy setting.
import type { Locator, Page } from '@playwright/test';
import { noteUi, notePanelPath } from '../fixtures/chapter-notes.ts';
import {
  copiedTexts,
  dragSelect,
  highlightUi,
  noteSetup,
  recordClipboard,
  selectionText,
} from '../fixtures/highlights.ts';
import { expect, signInAs, test, type E2EFixtures } from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const PREFERENCES = '/settings/preferences';
const COPIED = /복사했습니다\.|copied/i;
/** Long enough for a copy that should not happen to land: the hook works one task after pointerup. */
const SETTLE_MS = 150;

const userMenuTrigger = (page: Page) => page.getByRole('button', { name: /^(계정|account)/i });
const userMenu = (page: Page) => page.getByRole('dialog', { name: /^(계정 메뉴|account menu)$/i });
const themeRadio = (page: Page, name: RegExp) =>
  userMenu(page)
    .getByRole('radiogroup', { name: /화면 테마|theme/i })
    .getByRole('radio', { name });
const SYSTEM = /^(시스템|system)$/i;
const LIGHT = /^(라이트|light)$/i;
const DARK = /^(다크|dark)$/i;
const autoCopySwitch = (page: Page) =>
  page.getByRole('switch', { name: /드래그하면 자동 복사|auto.?copy/i });
const copiedToast = (page: Page) => page.getByRole('status').filter({ hasText: COPIED });
const pageTitle = (page: Page) => page.getByRole('heading', { level: 1 }).first();
const htmlTheme = (page: Page) =>
  page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const canvas = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim(),
  );
const themeCookie = async (page: Page) =>
  (await page.context().cookies()).find((cookie) => cookie.name === 'quiz-theme');

async function signIn(
  page: Page,
  workspaceFactory: E2EFixtures['workspaceFactory'],
  label: string,
) {
  const member = await workspaceFactory.member(label);
  await signInAs(page, member.user);
  return member;
}

async function enableAutoCopy(page: Page): Promise<void> {
  await page.goto(PREFERENCES);
  await autoCopySwitch(page).click();
  await expect(autoCopySwitch(page)).toBeChecked();
}

/** Double-clicks the word at the start of a block, whose box is wider than its text. */
const doubleClickWord = (target: Locator) => target.dblclick({ position: { x: 6, y: 12 } });

async function expectNothingCopied(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
  expect(await copiedTexts(page)).toEqual([]);
  await expect(copiedToast(page)).toHaveCount(0);
}

test.describe('UX12-SETTINGS', () => {
  test('UX12-SETTINGS-AC01 the user menu offers 시스템, 라이트 and 다크, 시스템 by default', async ({
    page,
    workspaceFactory,
  }) => {
    await signIn(page, workspaceFactory, 'ux12-settings-ac01');
    await page.goto('/workspaces');
    await userMenuTrigger(page).click();

    await expect(themeRadio(page, SYSTEM)).toBeChecked();
    await expect(themeRadio(page, LIGHT)).not.toBeChecked();
    await expect(themeRadio(page, DARK)).not.toBeChecked();

    await themeRadio(page, SYSTEM).focus();
    // Radix selects on the focus move, which comes a task after keydown: the key must stay down.
    await page.keyboard.press('ArrowRight', { delay: 50 });
    await expect(themeRadio(page, LIGHT)).toBeChecked();
    await expect(userMenu(page)).toBeVisible();
  });

  test('UX12-SETTINGS-AC02 a picked theme persists and the server stamps it', async ({
    page,
    workspaceFactory,
  }) => {
    await signIn(page, workspaceFactory, 'ux12-settings-ac02');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/workspaces');
    const light = await canvas(page);
    await userMenuTrigger(page).click();
    await themeRadio(page, DARK).click();

    await expect.poll(() => htmlTheme(page)).toBe('dark');
    await expect.poll(() => canvas(page)).not.toBe(light);
    await expect.poll(async () => (await themeCookie(page))?.value).toBe('dark');

    // The first byte of HTML already carries the theme: no flash and no inline script.
    const response = await page.reload();
    expect((await response?.text()) ?? '').toMatch(/<html[^>]*data-theme="dark"/);
    expect(await htmlTheme(page)).toBe('dark');
    await userMenuTrigger(page).click();
    await expect(themeRadio(page, DARK)).toBeChecked();

    // Garbage in the cookie is the same as no cookie.
    await page
      .context()
      .addCookies([{ name: 'quiz-theme', value: 'neon', url: new URL(page.url()).origin }]);
    const garbage = await page.reload();
    expect((await garbage?.text()) ?? '').not.toMatch(/<html[^>]*data-theme=/);
  });

  test('UX12-SETTINGS-AC03 시스템 follows prefers-color-scheme through the CSS alone', async ({
    page,
    workspaceFactory,
  }) => {
    await signIn(page, workspaceFactory, 'ux12-settings-ac03');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/workspaces');
    await userMenuTrigger(page).click();
    await expect(themeRadio(page, SYSTEM)).toBeChecked();
    expect(await htmlTheme(page)).toBeNull();
    const light = await canvas(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    const dark = await canvas(page);
    expect(dark).not.toBe(light);
    expect(await htmlTheme(page)).toBeNull();

    // Back from an explicit choice: the cookie and the attribute both go.
    await themeRadio(page, LIGHT).click();
    await expect.poll(() => canvas(page)).toBe(light);
    await expect.poll(async () => (await themeCookie(page))?.value).toBe('light');
    await themeRadio(page, SYSTEM).click();
    await expect.poll(() => htmlTheme(page)).toBeNull();
    await expect.poll(() => canvas(page)).toBe(dark);
    await expect.poll(() => themeCookie(page)).toBeUndefined();
  });

  test('UX12-SETTINGS-AC04 the setting is off by default and off copies nothing', async ({
    page,
    workspaceFactory,
  }) => {
    await page.goto(PREFERENCES);
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fpreferences$/);

    await recordClipboard(page);
    await signIn(page, workspaceFactory, 'ux12-settings-ac04');
    await page.goto('/workspaces');
    await userMenuTrigger(page).click();
    await userMenu(page)
      .getByRole('link', { name: /^(설정|settings)$/i })
      .click();
    await expect(page).toHaveURL(new RegExp(`${PREFERENCES}$`));
    await expect(autoCopySwitch(page)).not.toBeChecked();

    await doubleClickWord(pageTitle(page));
    expect(await selectionText(page)).not.toBe('');
    await expectNothingCopied(page);
  });

  test('UX12-SETTINGS-AC05 on copies a pointer selection at once and survives a reload', async ({
    page,
    workspaceFactory,
  }) => {
    await recordClipboard(page);
    await signIn(page, workspaceFactory, 'ux12-settings-ac05');
    await enableAutoCopy(page);

    // No reload needed: the hook lives in the shell around this very page.
    await doubleClickWord(pageTitle(page));
    await expect.poll(() => copiedTexts(page)).toHaveLength(1);
    expect((await copiedTexts(page))[0]?.trim()).toBe((await selectionText(page)).trim());
    await expect(copiedToast(page).first()).toBeVisible();

    await page.reload();
    await expect(autoCopySwitch(page)).toBeChecked();
    await doubleClickWord(pageTitle(page));
    await expect.poll(() => copiedTexts(page)).toHaveLength(1);

    // Repeated selections keep one toast.
    await expect(copiedToast(page).first()).toBeVisible();
    await page.getByText(/이 브라우저에만 저장/).dblclick();
    await expect.poll(() => copiedTexts(page)).toHaveLength(2);
    await expect(copiedToast(page)).toHaveCount(1);
  });

  test('UX12-SETTINGS-AC06 keyboard selections, editing fields and plain clicks copy nothing', async ({
    page,
    workspaceFactory,
  }) => {
    await recordClipboard(page);
    await signIn(page, workspaceFactory, 'ux12-settings-ac06');
    await enableAutoCopy(page);

    // Keyboard: Shift+arrow widens a selection with no pointer involved.
    await pageTitle(page).evaluate((el) => {
      const range = document.createRange();
      range.setStart(el.firstChild as Text, 0);
      range.setEnd(el.firstChild as Text, 1);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    });
    await page.keyboard.press('Shift+ArrowRight');
    expect(await selectionText(page)).not.toBe('');
    await expectNothingCopied(page);

    // The right button never copies.
    await pageTitle(page).click({ button: 'right' });
    await expectNothingCopied(page);
    await page.keyboard.press('Escape');

    // A press that leaves an existing selection alone does not copy it.
    await pageTitle(page).evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      const fire = (type: string) =>
        el.dispatchEvent(
          new PointerEvent(type, { bubbles: true, pointerType: 'mouse', isPrimary: true }),
        );
      fire('pointerdown');
      fire('pointerup');
    });
    await expectNothingCopied(page);

    // Editing fields, with a selection made by the mouse.
    await page.goto('/settings/security');
    const field = page.locator('input[type="password"]').first();
    await field.fill('secretvalue');
    await field.dblclick();
    await expectNothingCopied(page);

    await page.evaluate(() => {
      const editable = document.createElement('div');
      editable.contentEditable = 'true';
      editable.textContent = 'editable words here';
      editable.setAttribute('data-e2e-editable', '');
      document.querySelector('main')?.prepend(editable);
    });
    await doubleClickWord(page.locator('[data-e2e-editable]'));
    expect(await selectionText(page)).not.toBe('');
    await expectNothingCopied(page);
  });

  test('UX12-SETTINGS-AC07 reading text copies what the menu copies and the menu still opens', async ({
    page,
    workspaceFactory,
  }) => {
    const s = await noteSetup(workspaceFactory, 'ux12-settings-ac07');
    await recordClipboard(page);
    await signInAs(page, s.owner.user);
    await enableAutoCopy(page);

    await page.goto(notePanelPath(s.workspaceId, s.ch1));
    const panel = noteUi.panel(page);
    await expect(panel).toBeVisible();
    await dragSelect(highlightUi.noteBody(panel), '핵심 용어를 묻는다.');

    await expect.poll(() => copiedTexts(page)).toHaveLength(1);
    const [copied] = await copiedTexts(page);
    expect(copied).toBe('핵심 용어를 묻는다.');
    const menu = highlightUi.menu(page);
    await expect(menu).toBeVisible();
    expect(await selectionText(page)).toBe(copied);

    // The menu's own copy writes once; the kept selection does not auto-copy a second time.
    await menu.getByRole('menuitem', { name: /^(복사|copy)$/i }).click();
    await expect.poll(() => copiedTexts(page)).toHaveLength(2);
    await page.waitForTimeout(SETTLE_MS);
    expect(await copiedTexts(page)).toHaveLength(2);
  });

  test('UX12-SETTINGS-AC08 touch pointers never auto-copy and the setting says so', async ({
    page,
    workspaceFactory,
  }) => {
    await recordClipboard(page);
    await signIn(page, workspaceFactory, 'ux12-settings-ac08');
    await enableAutoCopy(page);
    await expect(page.getByText(/데스크톱/)).toBeVisible();

    await pageTitle(page).evaluate((el) => {
      const fire = (type: string) =>
        el.dispatchEvent(
          new PointerEvent(type, { bubbles: true, pointerType: 'touch', isPrimary: true }),
        );
      fire('pointerdown');
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      fire('pointerup');
    });
    expect(await selectionText(page)).not.toBe('');
    await expectNothingCopied(page);
  });
});
