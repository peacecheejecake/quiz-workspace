// UX12-NAV (docs/screens/ux12-navigation.md): a click on a page link answers at once with the
// link's own pending mark, and DOC-02 keeps answering an unknown document with HTTP 404.

import type { Locator, Page } from '@playwright/test';
import {
  createNumberedQuestions,
  expect,
  homePath,
  homeUi,
  importPath,
  main,
  notFoundHeading,
  overviewUi,
  signInAs,
  test,
  uploadReadyBook,
  type E2EFixtures,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

type Factory = E2EFixtures['workspaceFactory'];

const documentPath = (workspaceId: string, documentId: string) =>
  `/workspaces/${workspaceId}/documents/${documentId}`;
const pendingMark = (link: Locator) => link.locator('[data-link-pending]');

async function bookWorkspace(page: Page, factory: Factory, label: string) {
  const owner = await factory.member(label);
  const ws = await factory.create(owner);
  const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
  await createNumberedQuestions(owner, ws.id, label, 1);
  await signInAs(page, owner.user);
  return { ws, documentId };
}

/**
 * Holds every RSC answer of `pathname` from now on, prefetches too, so a click finds nothing to
 * show yet. Set before the link appears: a prefetch that lands first makes the click instant.
 */
async function holdRoute(page: Page, pathname: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      if (route.request().resourceType() !== 'document') await gate;
      await route.fallback();
    },
  );
  return release;
}

async function pressAndRelease(link: Locator, release: () => void) {
  await expect(link).toBeVisible();
  await expect(pendingMark(link)).toHaveCount(0);
  await link.click();
  await expect(pendingMark(link)).toBeVisible();
  release();
}

test(
  'UX12-NAV-AC01 breadcrumb, back and document links show a pending mark until the page answers',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { ws, documentId } = await bookWorkspace(page, workspaceFactory, 'ux12-nav-ac01');
    const home = homePath(ws.id);
    const target = documentPath(ws.id, documentId);
    const crumb = () => page.getByRole('navigation', { name: /위치/ }).getByRole('link').first();
    const back = () => main(page).getByRole('link', { name: /workspace 홈/i });

    for (const [from, link] of [
      [target, crumb],
      [target, back],
      [importPath(ws.id), crumb],
    ] as const) {
      const release = await holdRoute(page, home);
      await page.goto(from);
      await pressAndRelease(link(), release);
      await expect(overviewUi.heatmap(page)).toBeVisible();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }

    const release = await holdRoute(page, target);
    await homeUi.openDocuments(page);
    await pressAndRelease(homeUi.documentsDialog(page).locator(`a[href="${target}"]`), release);
    await expect(page).toHaveURL(new RegExp(`${target}(\\?|$)`));
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  },
);

test(
  'UX12-NAV-AC02 an unknown document still answers HTTP 404',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-nav-ac02');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    const res = await page.goto(documentPath(ws.id, '00000000-0000-4000-8000-000000000000'));
    expect(res?.status()).toBe(404);
    await expect(notFoundHeading(page)).toBeVisible();
  },
);
