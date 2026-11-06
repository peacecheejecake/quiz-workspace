// UX12-SEARCHPAGE (docs/screens/ux12-search-page.md): `AI에게 묻기` in the 본문 검색 page header.
import type { Page } from '@playwright/test';
import { askUi } from '../fixtures/ask.ts';
import { expect, signInAs, test, uploadReadyBook } from '../fixtures/test.ts';
import { searchPagePath, searchPageUi } from '../fixtures/ux9-pages.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({ storageState: { cookies: [], origins: [] } });

async function openSearchPage(page: Page, workspaceFactory: WorkspaceFactory, label: string) {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  await uploadReadyBook(owner, ws.id, 'book-en');
  await signInAs(page, owner.user);
  await page.goto(searchPagePath(ws.id));
  await expect(searchPageUi.heading(page)).toBeVisible();
  await expect(askUi.searchButton(page)).toBeVisible();
}

/** The button sits above the search form, not inside it. */
async function expectInHeader(page: Page) {
  const form = searchPageUi.form(page);
  await expect(form.getByRole('button', { name: /AI에게 묻기|ask ai/i })).toHaveCount(0);
  const button = await askUi.searchButton(page).boundingBox();
  const box = await form.boundingBox();
  if (!button || !box) throw new Error('the button and the form must be laid out');
  expect(button.y + button.height).toBeLessThanOrEqual(box.y);
}

test(
  'UX12-SEARCHPAGE-AC01 the ask button lives in the page header and keeps the search text',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await openSearchPage(page, workspaceFactory, 'ux12-searchpage-ac01');
    await expectInHeader(page);

    await searchPageUi.box(page).fill('chlorine');
    const before = page.url();
    await askUi.searchButton(page).click();
    const panel = askUi.panel(page);
    await expect(panel).toBeVisible();
    await expect(askUi.input(panel)).toHaveValue('chlorine');
    await expect(askUi.userMessages(panel)).toHaveCount(0);
    expect(page.url()).toBe(before);
  },
);

test(
  'UX12-SEARCHPAGE-AC02 the header fits a 375px screen without horizontal overflow',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    await openSearchPage(page, workspaceFactory, 'ux12-searchpage-ac02');
    await expectInHeader(page);

    const button = await askUi.searchButton(page).boundingBox();
    if (!button) throw new Error('the button must be laid out');
    expect(button.x).toBeGreaterThanOrEqual(0);
    expect(button.x + button.width).toBeLessThanOrEqual(375);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  },
);
