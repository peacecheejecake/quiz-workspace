// Real-browser checks of the heatmap marker contract (design-system.md §6/§6.1/§8) against the
// static Storybook build: state-matrix screenshots (5 statuses × square/star × default/hover/
// focus/selected, light/dark) plus geometry/color assertions jsdom cannot make.
import { expect, test, type Page } from '@playwright/test';

const STATUSES = ['unseen', 'viewed', 'incorrect', 'correct', 'retry'] as const;

async function openStory(page: Page, id: string, theme: 'light' | 'dark' = 'light') {
  await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`);
  await expect(page.locator('#storybook-root')).not.toBeEmpty({ timeout: 30_000 });
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

test('favorite keeps the status color and the 16px box of every status', async ({ page }) => {
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
    expect(sq).toMatchObject({ width: 16, height: 16 });
    expect(st).toMatchObject({ width: 16, height: 16 });
    expect(sqDot).toMatchObject({ width: 28, height: 28 });
    expect(stDot).toMatchObject({ width: 28, height: 28 });
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

test('mobile uses 32px cells', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStory(page, 'questions-questionheatmap--full');
  const box = await page.locator('[data-question-id="q-1-1"]').boundingBox();
  expect(box).toMatchObject({ width: 32, height: 32 });
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
