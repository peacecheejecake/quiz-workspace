// UX12-HOME: heatmap preview after the practice panel closes, and the desktop cell size
// (docs/screens/ux12-home.md). The hover scale stays in QOV-01-AC04 (questions-overview.spec.ts).
import type { Locator, Page } from '@playwright/test';
import {
  createNumberedQuestions,
  expect,
  overviewPath,
  overviewUi,
  panelUi,
  signInAs,
  test,
  type E2EFixtures,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

async function openHeatmap(
  page: Page,
  workspaceFactory: E2EFixtures['workspaceFactory'],
  label: string,
): Promise<void> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, ws.id, label, 3);
  await signInAs(page, owner.user);
  await page.goto(overviewPath(ws.id));
  await expect(overviewUi.heatmap(page)).toBeVisible();
}

async function openPanelFrom(page: Page, dot: Locator): Promise<Locator> {
  await dot.click();
  const panel = panelUi.panel(page);
  await expect(panel).toBeVisible();
  return panel;
}

/** The preview must stay closed for longer than its 200ms hover delay. */
async function expectNoPreview(page: Page): Promise<void> {
  await page.waitForTimeout(400);
  await expect(overviewUi.tooltip(page)).toHaveCount(0);
}

test(
  'UX12-HOME-AC01 closing the panel with its button returns focus without a preview',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await openHeatmap(page, workspaceFactory, 'ux12-home-ac01-button');
    const dot = overviewUi.dot(page, 2);
    const panel = await openPanelFrom(page, dot);

    await panelUi.close(panel).click();
    await expect(panel).toBeHidden();
    await page.mouse.move(0, 0);

    await expect(dot).toBeFocused();
    await expectNoPreview(page);
  },
);

test(
  'UX12-HOME-AC01 closing the panel with Esc returns focus without a preview',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await openHeatmap(page, workspaceFactory, 'ux12-home-ac01-esc');
    const dot = overviewUi.dot(page, 2);
    const panel = await openPanelFrom(page, dot);
    await page.mouse.move(0, 0);

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    await expect(dot).toBeFocused();
    await expectNoPreview(page);
  },
);

test(
  'UX12-HOME-AC02 after closing the panel hover and keyboard focus still preview the dot',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await openHeatmap(page, workspaceFactory, 'ux12-home-ac02');
    const dot = overviewUi.dot(page, 2);
    const panel = await openPanelFrom(page, dot);
    await page.mouse.move(0, 0);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(dot).toBeFocused();

    await dot.hover();
    await expect(overviewUi.tooltip(page)).toBeVisible();
    await page.mouse.move(0, 0, { steps: 4 }); // Radix closes on a move past its grace area.
    await page.mouse.move(1, 1);
    await expect(overviewUi.tooltip(page)).toHaveCount(0);

    // Arrow keys, not Tab: WebKit's Tab skips buttons. Tab itself is covered in questions.test.tsx.
    await page.keyboard.press('ArrowRight');
    await expect(dot).not.toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(dot).toBeFocused();
    await expect(overviewUi.tooltip(page)).toBeVisible();
  },
);

test(
  'UX12-HOME-AC03 desktop cells are 28px with 21px markers 7px apart; narrow screens keep 24px',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openHeatmap(page, workspaceFactory, 'ux12-home-ac03');
    const shape = (n: number) =>
      overviewUi.marker(overviewUi.dot(page, n)).locator('rect, path').boundingBox();

    const [cell, first, second] = await Promise.all([
      overviewUi.dot(page, 1).boundingBox(),
      shape(1),
      shape(2),
    ]);
    expect(cell).toMatchObject({ width: 28, height: 28 });
    expect(first?.width).toBeCloseTo(21, 1);
    expect(first?.height).toBeCloseTo(21, 1);
    expect((second?.x ?? 0) - ((first?.x ?? 0) + (first?.width ?? 0))).toBeCloseTo(7, 1);

    await page.setViewportSize({ width: 600, height: 800 });
    await expect.poll(async () => (await overviewUi.dot(page, 1).boundingBox())?.width).toBe(24);
  },
);
