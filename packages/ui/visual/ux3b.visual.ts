// Real-browser checks of the UX3b kit changes (design-system.md v1.2.2): switch track rim lighter
// than its fill, menu link items without underline in the menu text color, Dropzone,
// Breadcrumb/BackLink in PageHeader and stacking of several open side panels.
import { expect, test, type Locator, type Page } from '@playwright/test';

async function openStory(page: Page, id: string, theme: 'light' | 'dark' = 'light') {
  await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`);
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

/** WCAG relative luminance of a computed (sRGB channel list) color. */
function luminance(rgb: string): number {
  const [r = 0, g = 0, b = 0] = (rgb.match(/\d+(\.\d+)?/g) ?? []).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const css = (locator: Locator, property: string) =>
  locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

for (const theme of ['light', 'dark'] as const) {
  test(`switch track border is lighter than its fill (${theme})`, async ({ page }) => {
    const story = theme === 'light' ? 'switch-states' : 'switch-states-dark';
    await openStory(page, `foundation-input--${story}`, theme);
    const states = page.getByTestId('switch-states');
    const off = page.getByRole('switch', { name: '꺼짐' });
    const on = page.getByRole('switch', { name: '켜짐', exact: true });
    await expect(off).toHaveCSS('background-color', await tokenColor(page, '--color-switch-track'));
    await expect(off).toHaveCSS(
      'border-top-color',
      await tokenColor(page, '--color-switch-track-border'),
    );
    await expect(on).toHaveCSS('background-color', await tokenColor(page, '--color-accent'));
    for (const control of [off, on]) {
      const fill = luminance(await css(control, 'background-color'));
      const rim = luminance(await css(control, 'border-top-color'));
      expect(rim).toBeGreaterThan(fill);
    }
    // The thumb position, not color, tells the states apart.
    const thumbX = async (s: Locator) => (await s.locator('.thumb').boundingBox())?.x ?? 0;
    const [offBox, onBox] = [await off.boundingBox(), await on.boundingBox()];
    expect((await thumbX(on)) - (onBox?.x ?? 0)).toBeGreaterThan(
      (await thumbX(off)) - (offBox?.x ?? 0),
    );
    await expect(states).toHaveScreenshot(`switch-states-${theme}.png`);
  });
}

test('menu link items keep the menu color and never underline (rest, hover, focus)', async ({
  page,
}) => {
  await openStory(page, 'foundation-tooltip--menu');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const primary = await tokenColor(page, '--color-text-primary');
  const items = menu.getByRole('menuitem');
  await expect(items).toHaveCount(3);
  const check = async () => {
    for (const item of await items.all()) {
      await expect(item).toHaveCSS('text-decoration-line', 'none');
      await expect(item).toHaveCSS('color', primary);
    }
  };
  await check();
  await items.nth(1).hover();
  await check();
  await page.keyboard.press('ArrowDown');
  await check();
  // The workspaces form a labelled group, separated from the standalone entry.
  await expect(menu.getByRole('group', { name: '내 Workspace' })).toBeVisible();
  await expect(menu.getByRole('separator')).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(menu).toHaveScreenshot('menu-groups-links.png');
});

test('Dropzone: dashed region, drag-over state and a 24px+ pick button', async ({ page }) => {
  await openStory(page, 'foundation-dropzone--default');
  const zone = page.locator('.qz-dropzone');
  await expect(zone).toHaveCSS('border-top-style', 'dashed');
  const button = zone.getByRole('button', { name: '파일 선택' });
  const box = await button.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(24);
  await expect(zone).toHaveScreenshot('dropzone-default.png');

  await openStory(page, 'foundation-dropzone--dragging');
  const dragging = page.locator('.qz-dropzone[data-dragging]');
  await expect(dragging).toHaveCSS('border-top-style', 'solid');
  await expect(dragging).toHaveScreenshot('dropzone-dragging.png');
});

test('PageHeader with BackLink and Breadcrumb', async ({ page }) => {
  await openStory(page, 'layout-breadcrumb--in-page-header');
  const nav = page.getByRole('navigation', { name: '위치' });
  await expect(nav.getByText('3장 프로세스와 스레드')).toHaveAttribute('aria-current', 'page');
  for (const link of await nav.getByRole('link').all()) {
    expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(24);
  }
  expect((await page.getByRole('link', { name: '문서 목록' }).boundingBox())?.height).toBe(28);
  // UX5-UI: 12px (space-1 row gap + space-2 margin) between the location row and the title.
  const [navBox, titleBox] = await Promise.all([
    nav.boundingBox(),
    page.getByRole('heading', { level: 1 }).boundingBox(),
  ]);
  expect(navBox && titleBox && titleBox.y - (navBox.y + navBox.height)).toBeGreaterThanOrEqual(12);
  await expect(page.locator('.qz-page-header')).toHaveScreenshot('page-header-navigation.png');
});

test('the most recently opened side panel is on top; re-opening brings one back up', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openStory(page, 'layout-floatingsidepanel--stacked');
  const first = page.getByRole('dialog', { name: '검색 발췌' });
  const second = page.getByRole('dialog', { name: '문제 생성' });
  await expect(first).toBeVisible();
  const topmostTitle = () =>
    page.evaluate(() => {
      const el = document.elementFromPoint(window.innerWidth - 120, 200);
      return el?.closest('.qz-panel')?.querySelector('.title')?.textContent ?? null;
    });
  expect(await topmostTitle()).toBe('검색 발췌');

  await page.getByRole('button', { name: '문제 생성 열기' }).click();
  await expect(second).toBeVisible();
  await expect.poll(topmostTitle).toBe('문제 생성');

  // Close the first (covered) panel from the keyboard, then open it again.
  await first.getByRole('button', { name: '닫기' }).focus();
  await page.keyboard.press('Enter');
  await expect(first).toHaveCount(0);
  await page.getByRole('button', { name: '검색 발췌 열기' }).click();
  await expect(first).toBeVisible();
  await expect.poll(topmostTitle).toBe('검색 발췌');
});

/**
 * Clicks `button` and samples, on every animation frame for `ms`, the share of the progress bar
 * the fill covers or the dialog's height: the values a viewer actually sees between two states.
 */
async function framesAfterClick(
  page: Page,
  button: Locator,
  measure: 'fill' | 'dialog',
  ms = 800,
): Promise<number[]> {
  const handle = await button.elementHandle();
  return page.evaluate(
    ([el, what, duration]) =>
      new Promise<number[]>((done) => {
        const read = () => {
          if (what === 'dialog') {
            return document.querySelector<HTMLElement>('[role=dialog]')?.offsetHeight ?? 0;
          }
          const bar = document.querySelector('[role=progressbar]');
          const fill = bar?.firstElementChild;
          return bar && fill ? fill.getBoundingClientRect().width / bar.clientWidth : 0;
        };
        const samples: number[] = [];
        const start = performance.now();
        (el as HTMLElement).click();
        const tick = () => {
          samples.push(read());
          if (performance.now() - start < duration) requestAnimationFrame(tick);
          else done(samples);
        };
        requestAnimationFrame(tick);
      }),
    [handle, measure, ms] as const,
  );
}

test('UX5-UI the progress fill glides to a new value, and jumps under reduced motion', async ({
  page,
}) => {
  await openStory(page, 'feedback-progressbar--steps');
  const bar = page.getByRole('progressbar', { name: '업로드 진행률' });
  const next = page.getByRole('button', { name: '다음 단계' });
  await expect(bar).toHaveAttribute('aria-valuenow', '2');

  const frames = await framesAfterClick(page, next, 'fill');
  await expect(bar).toHaveAttribute('aria-valuenow', '40');
  // Several frames strictly between 2% and 40%, never going backwards, ending on 40%.
  expect(frames.filter((f) => f > 0.03 && f < 0.39).length).toBeGreaterThanOrEqual(3);
  expect(frames.every((f, i) => i === 0 || f >= (frames[i - 1] ?? 0) - 0.001)).toBe(true);
  expect(frames.at(-1)).toBeCloseTo(0.4, 2);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const instant = await framesAfterClick(page, next, 'fill', 200);
  await expect(bar).toHaveAttribute('aria-valuenow', '60');
  expect(instant.filter((f) => f > 0.41 && f < 0.59)).toEqual([]);
});
