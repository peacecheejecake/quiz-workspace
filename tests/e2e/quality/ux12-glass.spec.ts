// UX12 DESIGN-4 + SHELL-2 — the themed glass gradient, and the return bar's shape (user feedback
// 2026-11-06, decision D-3). Reads computed styles: pixel output is the visual suite's job, and
// prefers-reduced-transparency cannot be emulated here (packages/design-tokens/test covers it).
// The blur and the top bar without its gradient are UX12-GLASSBTN (ux12-glass-buttons.spec.ts).
import type { Locator, Page } from '@playwright/test';
import { seedViewerSettings, viewerUi } from '../fixtures/document-viewer.ts';
import {
  createQuestion,
  expect,
  mcqInput,
  overviewPath,
  overviewUi,
  panelUi,
  signInAs,
  test,
  uniqueWorkspaceName,
  uploadReadyBook,
  wsUi,
  type E2EFixtures,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const RETURN_BAR = '[data-app-global-control="practice-return"] > div';
const RETURN_LABEL = '보던 문제로 돌아가기';
const GRADIENT = /^linear-gradient\(.*rgba\(.*rgba\(/;
const OPAQUE = /^rgb\(/;
const TRANSLUCENT = /^rgba\(\d+, \d+, \d+, 0\.\d+\)$/;

function surfaceOf(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.backgroundColor,
      image: style.backgroundImage,
      blur: style.backdropFilter,
    };
  });
}

function shapeOf(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      paddingInline: [style.paddingLeft, style.paddingRight],
      radius: style.borderTopLeftRadius,
      borderColor: style.borderTopColor,
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    };
  });
}

async function openOverview(
  page: Page,
  workspaceFactory: E2EFixtures['workspaceFactory'],
  name: string,
) {
  const owner = await workspaceFactory.member(name);
  const ws = await workspaceFactory.create(owner);
  await createQuestion(owner, ws.id, {
    question_number: 1,
    ...mcqInput('UX12 glass 문제: 알맞은 것을 고르시오.', ['가', '나', '다', '라'], 1),
  });
  await signInAs(page, owner.user);
  await page.goto(overviewPath(ws.id));
}

async function openPanel(page: Page) {
  await overviewUi.dot(page, 1).click();
  const panel = panelUi.numbered(page, 1);
  await expect(panel).toBeVisible();
  return panel;
}

async function showReturnBar(page: Page) {
  const panel = await openPanel(page);
  await panelUi.close(panel).click();
  await expect(page.getByRole('button', { name: RETURN_LABEL })).toBeVisible();
  return page.locator(RETURN_BAR);
}

test(
  'UX12-GLASS-AC01 menus and side panels draw the themed gradient over the glass color',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-glass-01');
    const name = uniqueWorkspaceName('ux12-glass-01');
    const ws = await workspaceFactory.create(owner, name);
    await createQuestion(owner, ws.id, {
      question_number: 1,
      ...mcqInput('UX12 glass 문제: 알맞은 것을 고르시오.', ['가', '나', '다', '라'], 1),
    });
    await signInAs(page, owner.user);
    await page.goto('/workspaces');
    const gradients = new Set<string>();
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const bar = await surfaceOf(page.getByRole('banner'));
      expect(bar.color).toMatch(TRANSLUCENT);

      await wsUi.moreButton(wsUi.item(wsUi.tabPanel(page), name)).click();
      const menu = await surfaceOf(page.getByRole('menu'));
      expect(menu.image, `menu in ${colorScheme}`).toMatch(GRADIENT);
      gradients.add(menu.image);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toBeHidden();
    }
    expect(gradients.size, 'each theme has its own gradient').toBe(2);

    await page.goto(overviewPath(ws.id));
    await page.emulateMedia({ colorScheme: 'light' });
    const light = await surfaceOf(await openPanel(page));
    expect(light.image).toMatch(GRADIENT);
    expect(light.color).toMatch(TRANSLUCENT);
    await page.emulateMedia({ colorScheme: 'dark' });
    const dark = await surfaceOf(panelUi.numbered(page, 1));
    expect(dark.image).toMatch(GRADIENT);
    expect(dark.image).not.toBe(light.image);
  },
);

test.describe('phone sheet', () => {
  test.use({ viewport: { width: 390, height: 664 } });

  test(
    'UX12-GLASS-AC02 a phone sheet keeps the gradient on the opaque glass color, without blur',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await openOverview(page, workspaceFactory, 'ux12-glass-02');
      const sheet = await surfaceOf(await openPanel(page));
      expect(sheet.image).toMatch(GRADIENT);
      expect(sheet.color).toMatch(OPAQUE);
      expect(sheet.blur).toBe('none');
    },
  );
});

test(
  'UX12-GLASS-AC03 the tablet outline over the PDF stays one opaque color, without gradient or blur',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.setViewportSize({ width: 834, height: 1112 });
    const owner = await workspaceFactory.member('ux12-glass-03');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    await seedViewerSettings(page, { mode: 'both' });
    await signInAs(page, owner.user);
    await page.goto(`/workspaces/${ws.id}/documents/${documentId}`);
    await expect(viewerUi.settingsBar(page)).toBeVisible();
    await viewerUi.expandOutline(page).click();
    const panel = viewerUi.outlinePanel(page);
    await expect(panel).toBeVisible();
    const outline = await surfaceOf(panel);
    expect(outline.image).toBe('none');
    expect(outline.color).toMatch(OPAQUE);
    expect(outline.blur).toBe('none');
  },
);

test.describe('return bar', () => {
  test.use({ viewport: { width: 390, height: 664 } });

  test(
    'UX12-GLASS-AC04 the return bar is a wider rounded glass surface of the same height, with 44px targets',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await openOverview(page, workspaceFactory, 'ux12-glass-04');
      const bar = await showReturnBar(page);
      const button = page.getByRole('button', { name: RETURN_LABEL });
      const close = page.getByRole('button', { name: '복귀 버튼 닫기' });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        const surface = await surfaceOf(bar);
        expect(surface.image, `bar in ${colorScheme}`).toMatch(GRADIENT);
        expect(surface.color).toMatch(TRANSLUCENT);
      }
      const shape = await shapeOf(bar);
      expect(shape.height).toBe(52);
      expect(shape.paddingInline).toEqual(['24px', '24px']);
      expect(shape.radius).toBe('20px');

      const buttonShape = await shapeOf(button);
      expect(buttonShape.paddingInline).toEqual(['8px', '8px']);
      expect(buttonShape.height).toBeGreaterThanOrEqual(44);
      const closeShape = await shapeOf(close);
      expect(closeShape.height).toBeGreaterThanOrEqual(44);
      expect(closeShape.width).toBeGreaterThanOrEqual(44);
      // UX12-CONTROLS-AC01: a transparent 1px, which keeps the button's size.
      expect(closeShape.borderColor).toBe('rgba(0, 0, 0, 0)');
    },
  );

  test(
    'UX12-GLASS-AC06 the return message shares the bar surface and sits above it',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await openOverview(page, workspaceFactory, 'ux12-glass-06');
      const bar = await showReturnBar(page);
      // The lookup is a server action: a POST to the page itself.
      await page.route(
        (url) => url.pathname === new URL(page.url()).pathname,
        (route) => (route.request().method() === 'POST' ? route.abort() : route.fallback()),
      );
      await page.getByRole('button', { name: RETURN_LABEL }).click();
      const message = page
        .locator('[data-app-global-control="practice-return"]')
        .getByRole('status');
      await expect(message).toBeVisible();

      const [barSurface, messageSurface] = [await surfaceOf(bar), await surfaceOf(message)];
      expect(messageSurface.image).toMatch(GRADIENT);
      expect(messageSurface).toEqual(barSurface);
      const [barShape, messageShape] = [await shapeOf(bar), await shapeOf(message)];
      expect(messageShape.radius).toBe('20px');
      expect(messageShape.radius).toBe(barShape.radius);
      expect(messageShape.bottom).toBeLessThanOrEqual(barShape.top);
    },
  );
});

test.describe('narrow return bar', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test(
    'UX12-GLASS-AC05 at 320px the return bar narrows its padding and stays inside the screen',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await openOverview(page, workspaceFactory, 'ux12-glass-05');
      const shape = await shapeOf(await showReturnBar(page));
      expect(shape.paddingInline).toEqual(['12px', '12px']);
      expect(shape.height).toBe(52);
      expect(shape.left).toBeGreaterThanOrEqual(16);
      expect(shape.right).toBeLessThanOrEqual(304);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    },
  );
});
