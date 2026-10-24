// Real-browser checks of the heatmap marker contract (design-system.md §6/§6.1/§8) against the
// static Storybook build: state-matrix screenshots (5 statuses × square/star × default/hover/
// focus/selected, light/dark) plus geometry/color assertions jsdom cannot make.
import { expect, test, type Page } from '@playwright/test';

const STATUSES = ['unseen', 'viewed', 'incorrect', 'correct', 'retry'] as const;

async function openStory(page: Page, id: string, theme: 'light' | 'dark' = 'light') {
  await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`);
  // Wait for the story's first element (a lone dot has no text, so not toBeEmpty).
  await page.locator('#storybook-root > *').first().waitFor({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

/** The computed color of a token, resolved by the browser on a probe element. */
function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

for (const theme of ['light', 'dark'] as const) {
  test(`QuestionDot state matrix (${theme})`, async ({ page }) => {
    await openStory(page, 'questions-questiondot--state-matrix', theme);
    const matrix = page.getByTestId('state-matrix');
    await expect(matrix).toBeVisible();
    await expect(matrix).toHaveScreenshot(`question-dot-state-matrix-${theme}.png`);
  });
}

test('favorite keeps the status color and the cell-sized box of every status', async ({ page }) => {
  await openStory(page, 'questions-questiondot--state-matrix');
  for (const status of STATUSES) {
    const square = page.getByTestId(`dot-${status}-square-default`);
    const star = page.getByTestId(`dot-${status}-star-default`);
    const squareMarker = square.getByTestId('question-marker');
    const starMarker = star.getByTestId('question-marker');
    await expect(squareMarker).toHaveAttribute('data-shape', 'square');
    await expect(starMarker).toHaveAttribute('data-shape', 'star');

    const color = await tokenColor(page, `--question-status-${status}`);
    await expect(squareMarker).toHaveCSS('color', color);
    await expect(starMarker).toHaveCSS('color', color);

    const [sq, st, sqDot, stDot] = await Promise.all(
      [squareMarker, starMarker, square, star].map((l) => l.boundingBox()),
    );
    expect(sq).toMatchObject({ width: 24, height: 24 });
    expect(st).toMatchObject({ width: 24, height: 24 });
    expect(sqDot).toMatchObject({ width: 24, height: 24 });
    expect(stDot).toMatchObject({ width: 24, height: 24 });
  }
});

test('hover and keyboard focus scale only the marker; the grid does not move', async ({ page }) => {
  await openStory(page, 'questions-questionheatmap--full');
  const dots = page.locator('[data-question-id]');
  await expect(dots).toHaveCount(200);
  const dot = page.locator('[data-question-id="q-1-3"]');
  const neighbour = page.locator('[data-question-id="q-1-4"]');
  const marker = dot.getByTestId('question-marker');
  const before = await Promise.all([dot.boundingBox(), neighbour.boundingBox()]);
  await expect(marker).toHaveCSS('transform', 'none');

  await dot.hover();
  await expect.poll(() => marker.evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');
  await expect(page.getByRole('tooltip')).toBeVisible();
  expect(await Promise.all([dot.boundingBox(), neighbour.boundingBox()])).toEqual(before);
  await expect(dot).toHaveAttribute('data-status', /.+/);

  // Keyboard: the roving tab stop is the selected dot (q-2-5); Arrow keys move focus.
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  const selected = page.locator('[data-question-id="q-2-5"]');
  await expect(selected).toBeFocused();
  await expect
    .poll(() =>
      selected.getByTestId('question-marker').evaluate((el) => getComputedStyle(el).transform),
    )
    .not.toBe('none');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-question-id="q-2-6"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(page.locator('[data-question-id="q-2-6"]')).toBeFocused();
});

/** Drawn-shape gap between two horizontally adjacent dots, and the drawn width. */
async function drawnGap(page: Page, left: string, right: string) {
  const shape = (id: string) => page.locator(`[data-question-id="${id}"] .shape`).boundingBox();
  const [a, b] = await Promise.all([shape(left), shape(right)]);
  if (!a || !b) throw new Error('marker shape not rendered');
  expect(Math.abs(a.y - b.y)).toBeLessThan(1);
  return { gap: b.x - (a.x + a.width), width: a.width };
}

test('UX5-UI the gap between heatmap markers is at most 1/3 of the marker width', async ({
  page,
}) => {
  await openStory(page, 'questions-questionheatmap--full');
  const desktop = await drawnGap(page, 'q-1-1', 'q-1-2');
  expect(desktop.width).toBeGreaterThanOrEqual(18);
  expect(desktop.gap).toBeLessThanOrEqual(desktop.width / 3);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await drawnGap(page, 'q-1-1', 'q-1-2')).width).toBeGreaterThan(23);
  const mobile = await drawnGap(page, 'q-1-1', 'q-1-2');
  expect(mobile.gap).toBeLessThanOrEqual(mobile.width / 3);
});

test('mobile uses 32px cells', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStory(page, 'questions-questionheatmap--full');
  const box = await page.locator('[data-question-id="q-1-1"]').boundingBox();
  expect(box).toMatchObject({ width: 32, height: 32 });
});

test('a standalone dot (no heatmap ancestor) is 24px on desktop and 32px on mobile', async ({
  page,
}) => {
  await openStory(page, 'questions-questiondot--default');
  const dot = page.locator('[data-question-id]');
  expect(await dot.boundingBox()).toMatchObject({ width: 24, height: 24 });
  await expect(dot.getByTestId('question-marker')).toHaveCSS('width', '24px');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => dot.boundingBox()).toMatchObject({ width: 32, height: 32 });
  await expect(dot.getByTestId('question-marker')).toHaveCSS('width', '32px');
});

test('a standalone dot is 32px for a coarse pointer at desktop width', async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 1024, height: 768 },
  });
  const page = await context.newPage();
  await openStory(page, 'questions-questiondot--default');
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  expect(await page.locator('[data-question-id]').boundingBox()).toMatchObject({
    width: 32,
    height: 32,
  });
  await context.close();
});

test('touch devices (hover: none) never scale on hover', async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await openStory(page, 'questions-questionheatmap--full');
  expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
  const dot = page.locator('[data-question-id="q-1-3"]');
  await dot.hover();
  await expect(dot.getByTestId('question-marker')).toHaveCSS('transform', 'none');
  await context.close();
});
