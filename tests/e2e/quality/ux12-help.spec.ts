// UX12-HELP (docs/screens/ux12-help.md): the static help page opened from the user menu, with the
// release notes as one of its sections.
import type { Page } from '@playwright/test';
import { expect, signInAs, test } from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const userMenuTrigger = (page: Page) => page.getByRole('button', { name: /^(계정|account)/i });
const userMenu = (page: Page) => page.getByRole('dialog', { name: /^(계정 메뉴|account menu)$/i });
const helpHeading = (page: Page) =>
  page.getByRole('heading', { level: 1, name: /^(도움말|help)$/i });
const notesSection = (page: Page) =>
  page.getByRole('region', { name: /릴리스 노트|release notes/i });

test.describe('UX12-HELP', () => {
  test('UX12-HELP-AC01 the user menu opens the help page inside the app shell', async ({
    page,
    workspaceFactory,
  }) => {
    const member = await workspaceFactory.member('ux12-help-ac01');
    await signInAs(page, member.user);
    await page.goto('/workspaces');
    await userMenuTrigger(page).click();
    await userMenu(page)
      .getByRole('link', { name: /^(도움말|help)$/i })
      .click();

    await expect(page).toHaveURL(/\/help$/);
    await expect(helpHeading(page)).toBeVisible();
    await expect(userMenu(page)).toBeHidden();
    await expect(userMenuTrigger(page)).toBeVisible();
    const sections = await page.getByRole('heading', { level: 2 }).allTextContents();
    expect(sections.length).toBeGreaterThanOrEqual(3);
    expect(sections.at(-1)).toMatch(/릴리스 노트|release notes/i);
  });

  test('UX12-HELP-AC02 the release notes list dated changes in plain words', async ({
    page,
    workspaceFactory,
  }) => {
    const member = await workspaceFactory.member('ux12-help-ac02');
    await signInAs(page, member.user);
    await page.goto('/help');

    const notes = notesSection(page);
    await expect(notes.getByRole('heading', { level: 3 }).first()).toHaveText(/\d{4}년 \d{1,2}월/);
    const items = await notes.getByRole('listitem').allTextContents();
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(items.join('\n')).toMatch(/화면 테마/);
    // No internal Task IDs in user copy.
    expect(items.join('\n')).not.toMatch(/\b(UX\d+|SHELL|HOME|VIEW|EXPL)-?\d*\b/);
  });

  test('UX12-HELP-AC03 signed-out visitors go through login and the page fits 320px', async ({
    page,
    workspaceFactory,
  }) => {
    await page.goto('/help');
    await expect(page).toHaveURL(/\/login\?next=%2Fhelp$/);

    const member = await workspaceFactory.member('ux12-help-ac03');
    await signInAs(page, member.user);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/help');
    await expect(helpHeading(page)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
