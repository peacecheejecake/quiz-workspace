// Real-browser geometry of the paired dialog (design-system §5.6, QSRC-01-AC03/AC04): beside the
// open question panel from 868px, a full-screen sheet below. No screenshots, only boxes.
import { expect, test, type Page } from '@playwright/test';

async function openPaired(page: Page, width: number) {
  await page.setViewportSize({ width, height: 720 });
  await page.goto('/iframe.html?id=layout-floatingsidepanel--paired-dialog&viewMode=story');
  await page.getByRole('button', { name: '문제 원문 보기' }).waitFor({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: '문제 원문 보기' }).click();
  const paired = page.getByRole('dialog', { name: '문제 원문' });
  await expect(paired).toBeVisible();
  // Let the enter animation finish before measuring.
  await paired.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const box = await paired.boundingBox();
  const base = await page.locator('.qz-panel[data-side="end"]').boundingBox();
  if (!box || !base) throw new Error('missing panel boxes');
  return { box, base };
}

for (const width of [868, 1024, 1440]) {
  test(`paired dialog sits left of the question panel without overlap at ${width}px`, async ({
    page,
  }) => {
    const { box, base } = await openPaired(page, width);
    expect(box.x).toBeCloseTo(16, 0);
    expect(box.width).toBeGreaterThanOrEqual(320 - 0.5);
    expect(box.width).toBeLessThanOrEqual(500 + 0.5);
    expect(base.width).toBeCloseTo(500, 0);
    // A 16px gap or more between the two (868px: exactly 16px).
    expect(base.x - (box.x + box.width)).toBeGreaterThanOrEqual(16 - 0.5);
    expect(box.y).toBeCloseTo(16, 0);
  });
}

for (const width of [375, 767, 820, 867]) {
  test(`paired dialog is a full-screen sheet at ${width}px`, async ({ page }) => {
    const { box } = await openPaired(page, width);
    expect(box.x).toBeCloseTo(0, 0);
    expect(box.y).toBeCloseTo(0, 0);
    expect(box.width).toBeCloseTo(width, 0);
    expect(box.height).toBeCloseTo(720, 0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}
