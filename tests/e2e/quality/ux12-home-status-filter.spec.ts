// UX12-HOMEFILTER (docs/screens/ux12-home-status-filter.md): 검색·필터 on the sticky line, the
// status chips inside the 필터 popover, and 즐겨찾기만 turning 미열람 off.

import type { Locator, Page } from '@playwright/test';
import {
  closeSearchOptions,
  createNumberedQuestions,
  expect,
  homePath,
  homeUi,
  main,
  openQuestionSearch,
  openStatusFilters,
  overviewUi,
  signInAs,
  test,
  type E2EFixtures,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

type Factory = E2EFixtures['workspaceFactory'];

const REASON = /이미 열어 본 문제|already opened/i;
const FILTER_ACTIVE = /필터 적용 중|filters? (on|applied)/i;
const LOADING = /문제를 불러오는 중입니다|loading questions/i;
const FAVORITE = { name: /^(즐겨찾기만|favorites? only)$/i };

const filterButton = (page: Page) => homeUi.searchSettingsButton(page, 'questions');
const documentsButton = (page: Page) => homeUi.documentsButton(page);
const mockExams = (page: Page) => main(page).getByRole('button', { name: /^모의고사$/ });
const toolbar = (page: Page) => main(page).locator('[data-home-toolbar]');
const chip = (page: Page, status: string) =>
  homeUi.statusFilters(page).locator(`button[data-status="${status}"]`);
const favorite = (page: Page) => homeUi.statusFilters(page).getByRole('button', FAVORITE);

async function ownerHome(page: Page, factory: Factory, label: string, questions = 2) {
  const owner = await factory.member(label);
  const ws = await factory.create(owner);
  await createNumberedQuestions(owner, ws.id, label, questions);
  await signInAs(page, owner.user);
  await page.goto(homePath(ws.id));
  if (questions > 0) await expect(overviewUi.dots(page)).toHaveCount(questions);
  return { owner, ws };
}

const box = async (target: Locator) => {
  const found = await target.boundingBox();
  if (!found) throw new Error('not visible');
  return found;
};

const pageOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Relative luminance of a computed `rgb()` colour. */
function luminance(color: string): number {
  const [r, g, b] = (color.match(/[\d.]+/g) ?? []).map((part) => {
    const channel = Number(part) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [light = 0, dark = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

test(
  'UX12-HOMEFILTER-AC01 검색 and 필터 sit right of 모의고사 on the sticky line, with no chips on the page',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ownerHome(page, workspaceFactory, 'ux12-hf-01');
    const parts = await Promise.all(
      [
        documentsButton(page),
        mockExams(page),
        homeUi.questionSearchButton(page),
        filterButton(page),
        homeUi.historyButton(page),
        homeUi.shareButton(page),
      ].map(box),
    );
    const xs = parts.map((part) => part.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    const [documents, exams, search] = parts;
    if (!documents || !exams || !search) throw new Error('missing part');
    for (const part of parts) expect(part.y + part.height / 2).toBe(exams.y + exams.height / 2);
    expect(search.x - (exams.x + exams.width)).toBeGreaterThan(
      exams.x - (documents.x + documents.width),
    );
    await expect(page.locator('button[data-status]:not(.qz-question-dot)')).toHaveCount(0);
    await expect(page.getByRole('button', FAVORITE)).toHaveCount(0);

    await page.evaluate(() => {
      document.documentElement.style.minHeight = '3000px';
      window.scrollTo(0, 500);
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(500);
    const line = await box(toolbar(page));
    const stuck = await box(homeUi.questionSearchButton(page));
    expect(stuck.y).toBeGreaterThanOrEqual(line.y);
    expect(stuck.y + stuck.height).toBeLessThanOrEqual(line.y + line.height);
  },
);

test(
  'UX12-HOMEFILTER-AC02 the chips work in the popover by mouse and keyboard; Escape returns focus',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ownerHome(page, workspaceFactory, 'ux12-hf-02');
    const group = await openStatusFilters(page);
    await expect(group.locator('button[data-status]')).toHaveCount(5);
    await expect(group.locator('button[data-status] span[data-status]')).toHaveCount(5);
    await expect(group.getByRole('button', { name: /^미열람$/ })).toBeVisible();

    await chip(page, 'unseen').click();
    await expect(page).toHaveURL((url) => url.searchParams.has('status'));
    await expect(group).toBeVisible();
    await chip(page, 'unseen').focus();
    await page.keyboard.press('Enter');
    await expect(page).not.toHaveURL((url) => url.searchParams.has('status'));
    await favorite(page).focus();
    await page.keyboard.press('Space');
    await expect(favorite(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(group).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(group).toBeHidden();
    await expect(filterButton(page)).toBeFocused();
  },
);

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test(
    'UX12-HOMEFILTER-AC02 a tap toggles a chip and leaves the popover open',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await ownerHome(page, workspaceFactory, 'ux12-hf-02t');
      const button = await box(filterButton(page));
      await page.touchscreen.tap(button.x + button.width / 2, button.y + button.height / 2);
      const group = homeUi.statusFilters(page);
      await expect(group).toBeVisible();
      const unseen = await box(chip(page, 'unseen'));
      await page.touchscreen.tap(unseen.x + unseen.width / 2, unseen.y + unseen.height / 2);
      await expect(chip(page, 'unseen')).toHaveAttribute('aria-pressed', 'false');
      await expect(group).toBeVisible();
    },
  );
});

test(
  'UX12-HOMEFILTER-AC03 the button keeps saying a status filter is on after the popover closes',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ownerHome(page, workspaceFactory, 'ux12-hf-03');
    const button = filterButton(page);
    await expect(button).not.toHaveAttribute('data-active');
    await openStatusFilters(page);
    await chip(page, 'correct').click();
    await closeSearchOptions(page, 'questions');
    await expect(button).toHaveAttribute('data-active', 'true');
    await expect(button).toHaveAccessibleDescription(FILTER_ACTIVE);

    await openStatusFilters(page);
    await chip(page, 'correct').click();
    await expect(page).not.toHaveURL((url) => url.searchParams.has('status'));
    await expect(button).not.toHaveAttribute('data-active');
    await favorite(page).click();
    await closeSearchOptions(page, 'questions');
    await expect(button).toHaveAttribute('data-active', 'true');
    await openStatusFilters(page);
    await favorite(page).click();
    await expect(button).not.toHaveAttribute('data-active');
    await expect(button).not.toHaveAccessibleDescription(FILTER_ACTIVE);
  },
);

test(
  'UX12-HOMEFILTER-AC04 즐겨찾기만 turns 미열람 off with a stated reason and gives it back',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ownerHome(page, workspaceFactory, 'ux12-hf-04');
    await openStatusFilters(page);
    const unseen = chip(page, 'unseen');
    await expect(unseen).toHaveAttribute('aria-pressed', 'true');
    await expect(unseen).not.toHaveAttribute('aria-disabled');

    await favorite(page).click();
    await expect(unseen).toHaveAttribute('aria-disabled', 'true');
    await expect(unseen).toHaveAttribute('aria-pressed', 'false');
    await expect(unseen).toHaveAccessibleDescription(REASON);
    await expect(homeUi.statusFilterNote(page)).toHaveText(REASON);

    const before = page.url();
    await unseen.click({ force: true });
    await page.waitForTimeout(450); // longer than the 350ms status debounce
    await expect(unseen).toHaveAttribute('aria-pressed', 'false');
    expect(page.url()).toBe(before);

    await favorite(page).click();
    await expect(unseen).not.toHaveAttribute('aria-disabled');
    await expect(unseen).toHaveAttribute('aria-pressed', 'true');
    await expect(homeUi.statusFilterNote(page)).toHaveText('');

    // Off before 즐겨찾기만: off again after it.
    await unseen.click();
    await expect(unseen).toHaveAttribute('aria-pressed', 'false');
    await favorite(page).click();
    await expect(unseen).toHaveAttribute('aria-disabled', 'true');
    await favorite(page).click();
    await expect(unseen).toHaveAttribute('aria-pressed', 'false');
    await expect(unseen).not.toHaveAttribute('aria-disabled');
  },
);

test(
  'UX12-HOMEFILTER-AC05 a favorites deep link starts with 미열람 disabled',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { ws } = await ownerHome(page, workspaceFactory, 'ux12-hf-05');
    await page.goto(`${homePath(ws.id)}?favorite=true&status=unseen&status=correct`);
    await openStatusFilters(page);
    await expect(chip(page, 'unseen')).toHaveAttribute('aria-disabled', 'true');
    await expect(chip(page, 'unseen')).toHaveAttribute('aria-pressed', 'false');
    await expect(chip(page, 'correct')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip(page, 'viewed')).toHaveAttribute('aria-pressed', 'false');
    await expect(homeUi.statusFilterNote(page)).toHaveText(REASON);
  },
);

for (const theme of ['light', 'dark'] as const) {
  test(
    `UX12-HOMEFILTER-AC06 즐겨찾기만 on has no fill and accent text and border in ${theme}`,
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await page.emulateMedia({ colorScheme: theme });
      await ownerHome(page, workspaceFactory, `ux12-hf-06-${theme}`);
      await openStatusFilters(page);
      const button = favorite(page);
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(button.locator('svg')).toBeVisible();
      await page.mouse.move(0, 0); // no hover fill

      const style = await button.evaluate((el) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--color-accent)';
        el.append(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        const computed = getComputedStyle(el);
        return {
          accent,
          background: computed.backgroundColor,
          border: computed.borderTopColor,
          color: computed.color,
          surface: getComputedStyle(document.body).backgroundColor,
        };
      });
      await expect
        .poll(() => button.evaluate((el) => getComputedStyle(el).backgroundColor))
        .toBe('rgba(0, 0, 0, 0)');
      expect(style.color).toBe(style.accent);
      expect(style.border).toBe(style.accent);
      expect(contrast(style.color, style.surface)).toBeGreaterThanOrEqual(4.5);

      // The status chips keep their selected fill.
      await expect(chip(page, 'correct')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    },
  );
}

test(
  'UX12-HOMEFILTER-AC07 the loading text shows under the line and leaves no gap afterwards',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ownerHome(page, workspaceFactory, 'ux12-hf-07');
    const heatmap = overviewUi.heatmap(page);
    const restTop = (await box(heatmap)).y;

    const OVERVIEW = /\/api\/workspaces\/[^/]+\/questions\/overview/;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(OVERVIEW, async (route) => {
      await gate;
      await route.continue();
    });
    await openStatusFilters(page);
    await favorite(page).click();
    await closeSearchOptions(page, 'questions');

    const loading = main(page).getByRole('status').filter({ hasText: LOADING });
    await expect(loading).toBeVisible();
    const [text, line] = await Promise.all([box(loading), box(toolbar(page))]);
    expect(text.y).toBeGreaterThanOrEqual(line.y + line.height);
    release();
    await expect(loading).toHaveCount(0);
    await page.unroute(OVERVIEW);

    await openStatusFilters(page);
    await favorite(page).click();
    await closeSearchOptions(page, 'questions');
    await expect(overviewUi.dots(page)).toHaveCount(2);
    await expect.poll(async () => (await box(heatmap)).y).toBe(restTop);
  },
);

/** Every button keeps its name and stays on one row, with no page overflow. */
async function expectOneLine(page: Page): Promise<void> {
  const parts = await Promise.all(
    [
      documentsButton(page),
      mockExams(page),
      homeUi.questionSearchButton(page),
      filterButton(page),
      main(page).getByRole('button', { name: /^(AI 질문|ask ai)$/i }),
      homeUi.historyButton(page),
      homeUi.shareButton(page),
    ].map(box),
  );
  const centers = parts.map((part) => part.y + part.height / 2);
  for (const center of centers) expect(Math.abs(center - (centers[0] ?? 0))).toBeLessThan(1);
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
}

const expectRoomyBox = (page: Page, search: Locator) =>
  expect.poll(async () => (await box(search)).width).toBeGreaterThanOrEqual(120);

test.describe('375px', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test(
    'UX12-HOMEFILTER-AC08 seven buttons fit one line, the popover fits and search takes what is left',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await ownerHome(page, workspaceFactory, 'ux12-hf-08');
      await documentsButton(page)
        .locator('span span')
        .evaluate((el) => {
          el.textContent = '100';
        });
      await expectOneLine(page);

      const group = await openStatusFilters(page);
      const popover = await box(homeUi.searchSettings(page, 'questions'));
      expect(popover.x).toBeGreaterThanOrEqual(0);
      expect(popover.x + popover.width).toBeLessThanOrEqual(375);
      for (const button of await group.getByRole('button').all()) {
        await expect(button).toBeInViewport({ ratio: 1 });
      }
      await closeSearchOptions(page, 'questions');

      const search = await openQuestionSearch(page);
      await expectRoomyBox(page, search);
      await expectOneLine(page);
      const [field, filter] = await Promise.all([box(search), box(filterButton(page))]);
      expect(Math.abs(field.y + field.height / 2 - (filter.y + filter.height / 2))).toBeLessThan(1);

      const close = homeUi.questionSearchButton(page);
      await close.click();
      await expect(close).toBeFocused();
      await expect(mockExams(page)).toHaveText(/모의고사/);
      await expect(mockExams(page).getByText('모의고사')).toHaveCSS('position', 'static');
      await expectOneLine(page);
    },
  );
});

test.describe('360px', () => {
  test.use({ viewport: { width: 360, height: 667 } });

  test(
    'UX12-HOMEFILTER-AC08 the open box keeps 120px at 360px with every button on the line',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await ownerHome(page, workspaceFactory, 'ux12-hf-08n');
      const search = await openQuestionSearch(page);
      await expectRoomyBox(page, search);
      await expectOneLine(page);
    },
  );
});

test(
  'UX12-HOMEFILTER-AC09 the search message sits in the line only while there are no questions',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ownerHome(page, workspaceFactory, 'ux12-hf-09', 0);
    const message = homeUi.questionSearchMessage(page);
    await expect(message).toBeVisible();
    const [text, button, line] = await Promise.all([
      box(message),
      box(filterButton(page)),
      box(toolbar(page)),
    ]);
    expect(text.y).toBeGreaterThanOrEqual(button.y + button.height);
    expect(text.y + text.height).toBeLessThanOrEqual(line.y + line.height);
  },
);
