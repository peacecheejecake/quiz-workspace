// UX12 DESIGN-1 — button boundaries, hover backgrounds and compact button rows (user feedback
// 2026-11-06). Which buttons may drop the boundary is the invariant: docs/screens/ux12-controls.md.
import type { Locator, Page } from '@playwright/test';
import { askUi, openAskPanel } from '../fixtures/ask.ts';
import {
  expect,
  homePath,
  homeUi,
  openContentSearch,
  signInAs,
  test,
  wsUi,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const GAP = '4px';

const userMenuTrigger = (page: Page) => page.getByRole('button', { name: /^(계정|account)/i });

async function boundary(target: Locator) {
  return target.evaluate((element) => {
    const css = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      color: css.borderTopColor,
      width: css.borderTopWidth,
      style: css.borderTopStyle,
      boxHeight: box.height,
      boxWidth: box.width,
    };
  });
}

/** The token's value resolved by the browser, comparable to a computed background. */
async function hoverColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--color-state-hover)';
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
}

async function expectHoverBackground(page: Page, target: Locator): Promise<void> {
  const color = await hoverColor(page);
  await target.hover();
  await expect
    .poll(() => target.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe(color);
}

async function expectInvisibleBoundary(target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  await expect.poll(async () => (await boundary(target)).color).toBe(TRANSPARENT);
}

test(
  'UX12-CONTROLS-AC01 icon ghost buttons have no visible border and keep their size',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-ctl-01');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto('/workspaces');
    const more = wsUi.moreButton(wsUi.item(wsUi.tabPanel(page), ws.name));
    await expectInvisibleBoundary(more);
    const moreBox = await boundary(more);
    expect(moreBox.width).toBe('1px');
    expect(moreBox.boxHeight).toBeGreaterThanOrEqual(28);
    expect(moreBox.boxWidth).toBe(moreBox.boxHeight);

    await page.goto(homePath(ws.id));
    const panel = await openAskPanel(page);
    await expectInvisibleBoundary(askUi.close(panel));
  },
);

test(
  'UX12-CONTROLS-AC02 profile, back link and search settings show no border',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-ctl-02');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(`/workspaces/${ws.id}/search`);
    await expectInvisibleBoundary(userMenuTrigger(page));
    expect((await boundary(userMenuTrigger(page))).width).toBe('1px');
    // PROFILE-MENU: the buttons inside the opened menu are borderless as well.
    await userMenuTrigger(page).click();
    const menu = page.getByRole('dialog', { name: /계정 메뉴|account menu/i });
    for (const name of [/^설정$/, /계정 보안 설정/, /^도움말$/]) {
      await expectInvisibleBoundary(menu.getByRole('link', { name }));
    }
    await expectInvisibleBoundary(menu.getByRole('button', { name: /^로그아웃$/ }));
    await page.keyboard.press('Escape');
    const back = page.getByRole('link', { name: /Workspace 홈|workspace home/i });
    await expect(back).toBeVisible();
    expect((await boundary(back)).width).toBe('0px');

    await page.goto(homePath(ws.id));
    await openContentSearch(page);
    await expectInvisibleBoundary(homeUi.searchSettingsButton(page, 'body'));
  },
);

test(
  'UX12-CONTROLS-AC03 every other control keeps its boundary in both themes',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-ctl-03');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    const panel = await openAskPanel(page);
    const newConversation = askUi.newButton(panel);
    await expect(newConversation).toBeVisible();

    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      const offenders = await page.locator('.qz-button, .qz-icon-button').evaluateAll((items) =>
        items
          .filter((element) => {
            const css = getComputedStyle(element);
            const toggle =
              element.hasAttribute('aria-pressed') ||
              ['on', 'off'].includes(element.getAttribute('data-state') ?? '');
            const allowed =
              !toggle &&
              (element.classList.contains('qz-icon-button') ||
                (element.getAttribute('data-variant') === 'ghost' &&
                  element.hasAttribute('data-borderless')));
            return (
              !allowed &&
              css.backgroundColor === 'rgba(0, 0, 0, 0)' &&
              css.borderTopColor === 'rgba(0, 0, 0, 0)'
            );
          })
          .map((element) => element.outerHTML.slice(0, 120)),
      );
      expect(offenders).toEqual([]);
      // UX12-GLASSBTN: this primary icon button keeps its 1px border, transparent, and its fill.
      const border = await boundary(newConversation);
      expect(border.style).toBe('solid');
      expect(border.width).toBe('1px');
      await expect(newConversation).not.toHaveCSS('background-color', TRANSPARENT);
    }

    await page.goto('/workspaces');
    const tab = page.getByRole('tab').first();
    await expect(tab).toBeVisible();
    expect((await boundary(tab)).color).not.toBe(TRANSPARENT);
  },
);

test(
  'UX12-CONTROLS-AC04 borderless buttons and list titles show a hover background',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-ctl-04');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto('/workspaces');
    const item = wsUi.item(wsUi.tabPanel(page), ws.name);
    await expect(item).toBeVisible();
    await expectHoverBackground(page, wsUi.moreButton(item));
    await expectHoverBackground(page, item.getByRole('link', { name: ws.name }));
    await expectHoverBackground(page, userMenuTrigger(page));

    await page.goto(homePath(ws.id));
    await openContentSearch(page);
    await expectHoverBackground(page, homeUi.searchSettingsButton(page, 'body'));
  },
);

test(
  'UX12-CONTROLS-AC05 button rows use the compact gap with adequate targets',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-ctl-05');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto('/workspaces');
    const pageActions = page.locator('.qz-page-header > .actions').first();
    await expect(pageActions).toBeVisible();
    await expect(pageActions).toHaveCSS('column-gap', GAP);

    await pageActions.getByRole('button').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const row = dialog.getByRole('button', { name: /^(취소|cancel)$/i }).locator('..');
    await expect(row).toHaveCSS('column-gap', GAP);
    const boxes = await row
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect().height));
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    for (const height of boxes) expect(height).toBeGreaterThanOrEqual(24);
    await page.keyboard.press('Escape');

    await page.goto(`/workspaces/${ws.id}?panel=share`);
    await expect(page.locator('.qz-panel > .footer')).toHaveCSS('column-gap', GAP);
  },
);

test(
  'UX12-CONTROLS-AC06 forced colors bring the boundary back',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-ctl-06');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto('/workspaces');
    const more = wsUi.moreButton(wsUi.item(wsUi.tabPanel(page), ws.name));
    await expect(more).toBeVisible();
    // A browser-neutral read of the cascade: the specific forced-colors rule (the one that restores
    // the borderless buttons' boundary, recognised by its `:not([aria-pressed]` selector, not the
    // generic `:is(.qz-button, .qz-icon-button)`) applies to them.
    for (const target of [more, userMenuTrigger(page)]) {
      const restored = await target.evaluate((element) => {
        const hit: string[] = [];
        for (const sheet of Array.from(document.styleSheets)) {
          for (const rule of Array.from(sheet.cssRules)) {
            if (!(rule instanceof CSSMediaRule) || !rule.conditionText.includes('forced-colors')) {
              continue;
            }
            for (const inner of Array.from(rule.cssRules)) {
              if (
                inner instanceof CSSStyleRule &&
                inner.style.borderTopColor.toLowerCase() === 'buttontext' &&
                inner.selectorText.includes(':not([aria-pressed]') &&
                element.matches(inner.selectorText)
              ) {
                hit.push(inner.selectorText);
              }
            }
          }
        }
        return hit;
      });
      expect(restored.length).toBeGreaterThan(0);
    }
  },
);
