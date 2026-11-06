// UX12-HEADER (docs/screens/ux12-home-header.md): the sticky 문서 N · 풀기 line above the 문제
// search, and the single 문서 N menu that took in 문서 관리 and 본문 검색.

import type { Locator, Page } from '@playwright/test';
import {
  createNumberedQuestions,
  expect,
  homePath,
  homeUi,
  main,
  overviewUi,
  seedMembership,
  signInAs,
  test,
  type E2EFixtures,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const MENU_NAME = /^(문서|documents)\s*\d+$/i;
const trigger = (page: Page) => main(page).getByRole('button', { name: MENU_NAME });
const play = (page: Page) => main(page).getByRole('button', { name: /^풀기$/ });
const menu = (page: Page) => page.getByRole('menu', { name: MENU_NAME });
const item = (page: Page, name: RegExp) => menu(page).getByRole('menuitem', { name });
const DOCUMENTS = /^(문서 관리|documents)$/i;
const BODY_SEARCH = /^(본문 검색|body search|content search)$/i;

type Factory = E2EFixtures['workspaceFactory'];

async function ownerHome(page: Page, factory: Factory, label: string, questions = 1) {
  const owner = await factory.member(label);
  const ws = await factory.create(owner);
  await createNumberedQuestions(owner, ws.id, label, questions);
  await signInAs(page, owner.user);
  await page.goto(homePath(ws.id));
  await expect(overviewUi.heatmap(page)).toBeVisible();
  return { owner, ws };
}

const box = async (target: Locator) => {
  const found = await target.boundingBox();
  if (!found) throw new Error('not visible');
  return found;
};

/** The sticky line: the one element in the home that is `position: sticky`. */
const stickyLine = (page: Page) =>
  trigger(page).locator('xpath=ancestor::*[@data-home-toolbar]').first();

/** Gives the page room to scroll, inside the sticky line's containing block. */
async function stretchHome(page: Page): Promise<void> {
  await overviewUi.heatmap(page).evaluate((el: HTMLElement) => {
    el.style.minHeight = '250vh';
  });
}

const scrollTo = async (page: Page, y: number) => {
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(y);
};

async function openMenu(page: Page): Promise<void> {
  await expect(async () => {
    if (!(await menu(page).isVisible())) await trigger(page).click();
    await expect(menu(page)).toBeVisible({ timeout: 2_000 });
  }).toPass();
}

test(
  'UX12-HEADER-AC01 the line reads 문서 N, 풀기, 이력, 공유하기 above the 문제 search and one menu holds everything',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ownerHome(page, workspaceFactory, 'ux12-hdr-01');
    await expect(trigger(page)).toHaveAttribute('aria-haspopup', 'menu');
    await expect(trigger(page).locator('svg')).toHaveCount(1);
    await expect(
      main(page).getByRole('button', { name: /^(문제 메뉴|question menu)$/i }),
    ).toHaveCount(0);
    await expect(main(page).getByRole('link', { name: BODY_SEARCH })).toHaveCount(0);

    const parts = await Promise.all(
      [trigger(page), play(page), homeUi.historyButton(page), homeUi.shareButton(page)].map(box),
    );
    const xs = parts.map((part) => part.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    for (const part of parts) expect(part.y).toBe(parts[0]?.y);
    const search = await box(homeUi.questionSearch(page));
    expect(search.y).toBeGreaterThanOrEqual((parts[0]?.y ?? 0) + (parts[0]?.height ?? 0));

    await openMenu(page);
    const entries = await menu(page)
      .locator('[role="menuitem"], [role="separator"]')
      .evaluateAll((els) =>
        els.map((el) =>
          el.getAttribute('role') === 'separator' ? '|' : (el.textContent ?? '').trim(),
        ),
      );
    expect(entries).toEqual([
      '문서 관리',
      '본문 검색',
      '|',
      '직접 추가',
      '중복 문제 정리',
      '챕터 재분배',
      '|',
      '보관·초안 문제',
    ]);
  },
);

test(
  'UX12-HEADER-AC02 문서 관리 and 본문 검색 work for every role and 본문 검색 stays a real link',
  { tag: '@infra' },
  async ({ page, context, workspaceFactory }) => {
    const { owner, ws } = await ownerHome(page, workspaceFactory, 'ux12-hdr-02');
    const viewer = await workspaceFactory.member('ux12-hdr-02-viewer');
    seedMembership(ws.id, viewer.user.id, 'viewer');
    await page.context().clearCookies();
    await signInAs(page, viewer.user);
    const home = homePath(ws.id, 'q=numbered');
    await page.goto(home);
    await expect(trigger(page)).toBeVisible();

    await openMenu(page);
    await expect(item(page, DOCUMENTS)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(item(page, BODY_SEARCH)).not.toHaveAttribute('aria-disabled', 'true');
    await item(page, DOCUMENTS).click();
    await expect(page).toHaveURL(/[?&]panel=documents(&|$)/);
    await expect(homeUi.documentsDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(homeUi.documentsDialog(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();

    const searchPath = `/workspaces/${ws.id}/search`;
    await openMenu(page);
    await expect(item(page, BODY_SEARCH)).toHaveAttribute('href', searchPath);
    const opened = context.waitForEvent('page');
    await item(page, BODY_SEARCH).click({ modifiers: ['ControlOrMeta'] });
    const tab = await opened;
    await expect(tab).toHaveURL((url) => url.pathname === searchPath);
    await tab.close();
    expect(new URL(page.url()).pathname).toBe(homePath(ws.id));

    await openMenu(page);
    await item(page, BODY_SEARCH).click();
    await expect(page).toHaveURL((url) => url.pathname === searchPath);
    await page.goBack();
    await expect(page).toHaveURL((url) => `${url.pathname}${url.search}` === home);

    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(item(page, DOCUMENTS)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item(page, BODY_SEARCH)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL((url) => url.pathname === searchPath);

    await workspaceFactory.archive(owner, ws.id);
    await page.goto(homePath(ws.id));
    await openMenu(page);
    await expect(item(page, DOCUMENTS)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(item(page, BODY_SEARCH)).not.toHaveAttribute('aria-disabled', 'true');
  },
);

test(
  'UX12-HEADER-AC03 the line stays under the app header and the heatmap passes behind it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ownerHome(page, workspaceFactory, 'ux12-hdr-03');
    await stretchHome(page);
    const line = stickyLine(page);
    const banner = await box(page.getByRole('banner').first());
    const appBottom = banner.y + banner.height;

    await scrollTo(page, 500);
    expect((await box(line)).y).toBe(appBottom);
    const search = await box(homeUi.questionSearch(page));
    expect(search.y + search.height).toBeLessThanOrEqual(appBottom);

    const style = await line.evaluate((el) => {
      const computed = getComputedStyle(el);
      const header = document.querySelector('header');
      return {
        position: computed.position,
        background: computed.backgroundColor,
        z: Number(computed.zIndex),
        appZ: Number(header ? getComputedStyle(header).zIndex : Number.NaN),
      };
    });
    expect(style.position).toBe('sticky');
    expect(style.background).toMatch(/^rgb\(/); // opaque: only rgba() carries an alpha
    expect(style.z).toBeLessThan(style.appZ);

    // Put the first marker right behind the line: the line is what a press there hits.
    await scrollTo(page, 0);
    const dot = await box(overviewUi.dots(page).first());
    const lineBox = await box(line);
    await scrollTo(page, Math.round(dot.y - lineBox.y));
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-home-toolbar]') != null,
      { x: dot.x + dot.width / 2, y: lineBox.y + dot.height / 2 },
    );
    expect(hit, 'the line covers the marker').toBe(true);
  },
);

test(
  'UX12-HEADER-AC04 a dot reached with the arrow keys comes out from behind the line',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ownerHome(page, workspaceFactory, 'ux12-hdr-04', 3);
    await stretchHome(page);
    const first = overviewUi.dot(page, 1);
    const lineBox = await box(stickyLine(page));
    const start = await box(first);
    // The marker sits behind the line, focused without scrolling.
    await scrollTo(page, Math.round(start.y - lineBox.y));
    await first.evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
    await page.keyboard.press('ArrowRight');
    const second = overviewUi.dot(page, 2);
    await expect(second).toBeFocused();
    await expect
      .poll(async () => (await box(second)).y)
      .toBeGreaterThanOrEqual(lineBox.y + lineBox.height);
  },
);

test.describe('375px', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test(
    'UX12-HEADER-AC05 every button of the line stays on one line with no page overflow',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await ownerHome(page, workspaceFactory, 'ux12-hdr-05');
      const parts = await Promise.all(
        [trigger(page), play(page), homeUi.historyButton(page), homeUi.shareButton(page)].map(box),
      );
      const centers = parts.map((part) => part.y + part.height / 2);
      for (const center of centers) expect(Math.abs(center - (centers[0] ?? 0))).toBeLessThan(1);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
    },
  );
});

test(
  'UX12-HEADER-AC06 opening and closing a dialog from the menu moves neither the page nor the line',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ownerHome(page, workspaceFactory, 'ux12-hdr-06');
    await stretchHome(page);
    await scrollTo(page, 500);
    const before = await box(trigger(page));
    await openMenu(page);
    await item(page, DOCUMENTS).click();
    await expect(homeUi.documentsDialog(page)).toBeVisible();
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(500);
    const behindDialog = page
      .locator('main')
      .getByRole('button', { name: MENU_NAME, includeHidden: true });
    expect(await box(behindDialog)).toEqual(before);
    await page.keyboard.press('Escape');
    await expect(homeUi.documentsDialog(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(500);
    expect(await box(trigger(page))).toEqual(before);
  },
);
