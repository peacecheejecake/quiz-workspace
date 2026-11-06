import { expect, homeUi, overviewPath, signInAs, test, wsUi } from '../fixtures/test.ts';
import { drag, inlineTranslate, line } from '../fixtures/overlay-drag.ts';
import type { Locator } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

async function swipe(target: Locator, dx: number, dy: number, pointerType = 'touch') {
  await target.evaluate(
    (element, delta) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + 4;
      const y = rect.top + 4;
      const init = {
        bubbles: true,
        pointerId: 1,
        pointerType: delta.pointerType,
        isPrimary: true,
        clientX: x,
        clientY: y,
      };
      element.dispatchEvent(new PointerEvent('pointerdown', init));
      window.dispatchEvent(
        new PointerEvent('pointerup', { ...init, clientX: x + delta.dx, clientY: y + delta.dy }),
      );
    },
    { dx, dy, pointerType },
  );
}

test(
  'UX10-UI-AC01 controls expose boundaries in both themes',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux10-ui-01');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      const controls = page.locator('.qz-button, .qz-icon-button');
      expect(await controls.count()).toBeGreaterThan(0);
      // UX12-CONTROLS: only icon ghost and `borderless` buttons may drop the boundary.
      const invisible = await controls.evaluateAll(
        (items) =>
          items.filter((element) => {
            const css = getComputedStyle(element);
            const toggle =
              element.hasAttribute('aria-pressed') ||
              ['on', 'off'].includes(element.getAttribute('data-state') ?? '');
            const allowed =
              element.getAttribute('data-variant') === 'ghost' &&
              !toggle &&
              (element.classList.contains('qz-icon-button') ||
                element.hasAttribute('data-borderless'));
            return (
              !allowed &&
              css.backgroundColor === 'rgba(0, 0, 0, 0)' &&
              (css.borderStyle === 'none' || css.borderColor === 'rgba(0, 0, 0, 0)')
            );
          }).length,
      );
      expect(invisible).toBe(0);
    }
    await page.goto('/workspaces');
    const tabs = page.getByRole('tab');
    await expect(tabs.first()).toBeVisible();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      for (const tab of await tabs.all()) {
        const style = await tab.evaluate((element) => {
          const css = getComputedStyle(element);
          return { border: css.borderStyle, color: css.borderColor, boxSizing: css.boxSizing };
        });
        expect(style.border).not.toBe('none');
        expect(style.color).not.toBe('rgba(0, 0, 0, 0)');
        expect(style.boxSizing).toBe('border-box');
      }
    }
  },
);

test(
  'UX10-UI-AC02 AI question icon mark is centered and label remains',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux10-ui-02');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    const button = page.getByRole('button', { name: /AI 질문|ask AI/i });
    await expect(button).toBeVisible();
    const center = await button
      .locator('svg path')
      .last()
      .evaluate((path) => {
        const box = (path as SVGGraphicsElement).getBBox();
        return [box.x + box.width / 2, box.y + box.height / 2];
      });
    expect(center).toEqual([12, 12]);
  },
);

test(
  'UX10-UI-AC03 modal header swipe closes and returns focus',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const member = await workspaceFactory.member('ux10-ui-03');
    await signInAs(page, member.user);
    await page.goto('/workspaces');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const opener = wsUi.createButton(page);
    await opener.click();
    const dialog = wsUi.createDialog(page);
    await expect(dialog).toBeVisible();
    // UX12 DESIGN-3: a centered dialog goes down, from anywhere in the header, following the finger.
    const seen = await drag(dialog.locator(':scope > .header .title'), line(0, 120));
    expect(seen).toEqual(['0px 30px', '0px 60px', '0px 90px', '0px 120px']);
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  },
);

test(
  'UX10-UI-AC04 short and body swipes leave the panel open',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux10-ui-04');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await homeUi.openDocuments(page);
    const dialog = homeUi.documentsDialog(page);
    await swipe(dialog.locator(':scope > .header'), 5, 5);
    await swipe(dialog.locator(':scope > .body'), 100, 100);
    await expect(dialog).toBeVisible();
    // UX12 DESIGN-3: a drag against the panel's direction moves it a little, then springs back.
    const seen = await drag(dialog.locator(':scope > .header .title'), line(-100, 0));
    expect(seen.at(-1)).toMatch(/^-[\d.]+px 0px$/);
    await expect.poll(() => inlineTranslate(dialog)).toBe('');
    await expect(dialog).toBeVisible();
  },
);
