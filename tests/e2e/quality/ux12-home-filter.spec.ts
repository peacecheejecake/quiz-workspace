// UX12-FILTER (docs/screens/ux12-home-filter.md): 검색 and 필터 on the sticky line (UX12-HOMEFILTER).
// The search box opens from an icon button next to 필터; the filters live in the 필터 popover.

import type { Locator, Page } from '@playwright/test';
import {
  answerCorrectly,
  chooseFilter,
  closeSearchOptions,
  createNumberedQuestions,
  expect,
  homePath,
  homeUi,
  main,
  openQuestionSearch,
  openSearchOptions,
  openStatusFilters,
  overviewUi,
  setMyState,
  signInAs,
  test,
  type E2EFixtures,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

type Factory = E2EFixtures['workspaceFactory'];

const CLOSE_SEARCH = /^(검색 닫기|close search)$/i;
const OPEN_SEARCH = /^(검색|search)$/i;
const CHAPTER = /^(챕터|chapter)$/i;
const TYPE = /^(유형|type)$/i;
const ESSAY = /서술형|essay/i;
const ALL_TYPES = /전체 유형|all types/i;
const FILTER_ACTIVE = /필터 적용 중|filters? (on|applied)/i;

const filterButton = (page: Page) => homeUi.searchSettingsButton(page, 'questions');
const filterPopover = (page: Page) => homeUi.searchSettings(page, 'questions');
const statusChip = (page: Page, status: string) =>
  homeUi.statusFilters(page).locator(`button[data-status="${status}"][aria-pressed]`);
/** The grid whose middle column opens: the search button's parent. */
const searchLine = (page: Page) => homeUi.questionSearchButton(page).locator('..');

async function ownerHome(page: Page, factory: Factory, label: string, questions = 3) {
  const owner = await factory.member(label);
  const ws = await factory.create(owner);
  const created = await createNumberedQuestions(owner, ws.id, label, questions);
  await signInAs(page, owner.user);
  await page.goto(homePath(ws.id));
  await expect(overviewUi.dots(page)).toHaveCount(questions);
  return { owner, ws, created };
}

const box = async (target: Locator) => {
  const found = await target.boundingBox();
  if (!found) throw new Error('not visible');
  return found;
};

const durations = (target: Locator) =>
  target.evaluate((el) => getComputedStyle(el).transitionDuration);

/** The closed box cannot be seen or reached; its column has no width. */
async function expectClosedBox(page: Page): Promise<void> {
  const state = await homeUi.header(page).evaluate((form) => {
    const slot = form.querySelector('input[type="search"]')?.closest('[inert]');
    if (!slot) return null;
    const style = getComputedStyle(slot);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    return { opacity: style.opacity, room: slot.getBoundingClientRect().width - padding };
  });
  expect(state).toEqual({ opacity: '0', room: 0 });
}

test(
  'UX12-FILTER-AC01 the sticky line holds 검색 and 필터 and the old controls are gone',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ownerHome(page, workspaceFactory, 'ux12-filter-01');
    const search = homeUi.questionSearchButton(page);
    await expect(search).toHaveAccessibleName(OPEN_SEARCH);
    await expect(search).toHaveAttribute('aria-expanded', 'false');
    const filter = filterButton(page);
    const [searchBox, filterBox, toolbar] = await Promise.all([
      box(search),
      box(filter),
      box(main(page).locator('[data-home-toolbar]')),
    ]);
    expect(searchBox.y).toBeGreaterThanOrEqual(toolbar.y);
    expect(searchBox.y + searchBox.height).toBeLessThanOrEqual(toolbar.y + toolbar.height);
    expect(filterBox.y).toBe(searchBox.y);
    expect(filterBox.x).toBeGreaterThan(searchBox.x);
    await expectClosedBox(page);

    // inert: not even a script can focus the closed box (Tab skips buttons in WebKit by default).
    await homeUi.header(page).evaluate((form) => {
      form.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    });
    await expect(page.locator('input[type="search"]:focus')).toHaveCount(0);

    await expect(main(page).getByRole('combobox')).toHaveCount(0);
    await expect(main(page).getByText(/^(챕터|유형)$/)).toHaveCount(0);
    for (const gone of [/^다시 풀기만$/, /^필터 초기화$/]) {
      await expect(main(page).getByRole('button', { name: gone })).toHaveCount(0);
    }
    const statuses = await openStatusFilters(page);
    await expect(statuses.getByRole('button', { name: /^즐겨찾기만$/ })).toBeVisible();
    await expect(statuses.getByRole('button', { name: /^다시 풀기$/ })).toBeVisible();
  },
);

test(
  'UX12-FILTER-AC02 opening 검색 widens the gap, turns the button into a borderless arrow and focuses the box',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await ownerHome(page, workspaceFactory, 'ux12-filter-02');
    const button = homeUi.questionSearchButton(page);
    const before = await box(filterButton(page));
    const line = searchLine(page);
    const transition = await line.evaluate((el) => {
      const style = getComputedStyle(el);
      return { property: style.transitionProperty, duration: style.transitionDuration };
    });
    expect(transition.property).toContain('grid-template-columns');
    expect(transition.duration).not.toMatch(/^0s(, 0s)*$/);

    await button.click();
    const search = homeUi.questionSearch(page);
    await expect(search).toBeFocused();
    await expect(button).toHaveAccessibleName(CLOSE_SEARCH);
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(button).toHaveAttribute('data-variant', 'ghost');
    await expect(button).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await expect
      .poll(async () => (await box(filterButton(page))).x)
      .toBeGreaterThan(before.x + 200);
    await expect.poll(async () => (await box(search)).width).toBeGreaterThan(200);
    const [opened, filter, arrow] = await Promise.all([
      box(search),
      box(filterButton(page)),
      box(button),
    ]);
    expect(opened.x).toBeGreaterThan(arrow.x + arrow.width - 1);
    expect(opened.x + opened.width).toBeLessThanOrEqual(filter.x);

    await search.pressSequentially('ux12-filter-02-1', { delay: 10 });
    await expect(page).toHaveURL((url) => url.searchParams.has('q'));
    await expect(overviewUi.dots(page)).toHaveCount(1);
  },
);

test(
  'UX12-FILTER-AC03 closing clears the query and returns focus, also before the debounce fires',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ownerHome(page, workspaceFactory, 'ux12-filter-03');
    const search = await openQuestionSearch(page);
    await search.fill('ux12-filter-03-1');
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(page).toHaveURL((url) => url.searchParams.has('q'));

    const button = homeUi.questionSearchButton(page);
    await button.click();
    await expect(overviewUi.dots(page)).toHaveCount(3);
    await expect(page).toHaveURL((url) => !url.searchParams.has('q'));
    await expect(button).toBeFocused();
    await expect(button).toHaveAccessibleName(OPEN_SEARCH);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expectClosedBox(page);

    await button.click();
    await expect(search).toHaveValue('');
    await search.pressSequentially('ux12', { delay: 0 });
    await button.click();
    await page.waitForTimeout(600); // past the 350ms debounce
    await expect(page).toHaveURL((url) => !url.searchParams.has('q'));
    await expect(overviewUi.dots(page)).toHaveCount(3);
  },
);

test(
  'UX12-FILTER-AC04 a query in the URL opens the search, on landing and when it arrives later',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { ws } = await ownerHome(page, workspaceFactory, 'ux12-filter-04');
    const path = homePath(ws.id);
    await page.goto(`${path}?q=ux12-filter-04-1`);
    await expect(overviewUi.dots(page)).toHaveCount(1);
    const button = homeUi.questionSearchButton(page);
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(homeUi.questionSearch(page)).toBeVisible();
    await expect(homeUi.questionSearch(page)).toHaveValue('ux12-filter-04-1');

    // Closing writes the URL over the same entry; a client navigation to one with `q` follows it.
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate((url) => window.history.pushState(null, '', url), `${path}?q=ux12`);
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(homeUi.questionSearch(page)).toHaveValue('ux12');
  },
);

test(
  'UX12-FILTER-AC05 without questions the 검색 button is disabled and states why',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-filter-05');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    const button = homeUi.questionSearchButton(page);
    await expect(button).toBeDisabled();
    const reason = /검색할 문제가 없|no questions to search/i;
    await expect(homeUi.questionSearchMessage(page)).toHaveText(reason);
    await expect(homeUi.questionSearchMessage(page)).toBeVisible();
    await expect(button).toHaveAccessibleDescription(reason);
  },
);

test(
  'UX12-FILTER-AC06 필터 opens and closes on its button, keeps visually unlabelled selects and shows it is active',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await ownerHome(page, workspaceFactory, 'ux12-filter-06', 2);
    const filter = filterButton(page);
    const popover = filterPopover(page);
    await filter.click();
    await expect(popover).toBeVisible();
    await expect(filter).toHaveAttribute('aria-expanded', 'true');
    await filter.click();
    await expect(popover).toBeHidden();
    await expect(filter).toBeFocused();
    await filter.click();

    const chapter = popover.getByRole('combobox', { name: CHAPTER });
    const type = popover.getByRole('combobox', { name: TYPE });
    await expect(chapter).toBeVisible();
    await expect(type).toBeVisible();
    for (const text of ['챕터', '유형']) {
      const label = popover.getByText(text, { exact: true });
      const width = await label.evaluate((el) => el.getBoundingClientRect().width);
      expect(width, `${text} is not shown`).toBeLessThanOrEqual(1);
    }
    await expect(filter).not.toHaveAttribute('data-active', /.*/);

    await chooseFilter(page, type, ESSAY);
    await expect(page).toHaveURL((url) => url.searchParams.get('type') === 'ESSAY');
    await expect(overviewUi.heatmap(page)).toHaveCount(0);
    await closeSearchOptions(page, 'questions');
    await expect(filter).toBeFocused();
    await expect(filter).toHaveAttribute('data-active', 'true');
    await expect(filter).toHaveAccessibleDescription(FILTER_ACTIVE);
    expect(await filter.evaluate((el) => getComputedStyle(el, '::after').content)).not.toBe('none');

    await openSearchOptions(page, 'questions');
    await chooseFilter(page, type, ALL_TYPES);
    await expect(page).toHaveURL((url) => !url.searchParams.has('type'));
    await expect(overviewUi.dots(page)).toHaveCount(2);
    await closeSearchOptions(page, 'questions');
    await expect(filter).not.toHaveAttribute('data-active', /.*/);
    await expect(filter).not.toHaveAccessibleDescription(FILTER_ACTIVE);
  },
);

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 700 } });

  test(
    'UX12-FILTER-AC07 the popover spans the viewport minus the page gutter',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await ownerHome(page, workspaceFactory, 'ux12-filter-07', 1);
      const popover = await openSearchOptions(page, 'questions');
      await expect.poll(async () => (await box(popover)).x).toBe(16);
      expect((await box(popover)).width).toBe(343);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        375,
      );
    },
  );
});

test(
  'UX12-FILTER-AC08 reduced motion opens and closes the search at once',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await ownerHome(page, workspaceFactory, 'ux12-filter-08', 1);
    const button = homeUi.questionSearchButton(page);
    expect(await durations(searchLine(page))).toMatch(/^0s(, 0s)*$/);
    await button.click();
    const search = homeUi.questionSearch(page);
    await expect(search).toBeFocused();
    // No animation: the first read after opening is already the final state.
    expect((await box(search)).width).toBeGreaterThan(200);
    const slot = search.locator('xpath=ancestor::*[@id][1]');
    expect(await durations(slot)).toMatch(/^0s(, 0s)*$/);
    expect(await slot.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await button.click();
    await expectClosedBox(page);
  },
);

test(
  'UX12-FILTER-AC09 a filtered empty heatmap keeps 필터 초기화 and it clears everything',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { ws } = await ownerHome(page, workspaceFactory, 'ux12-filter-09', 2);
    await page.goto(`${homePath(ws.id)}?type=ESSAY&status=correct&q=none`);
    await expect(overviewUi.heatmap(page)).toHaveCount(0);
    const reset = main(page).getByRole('button', { name: /^(필터 초기화|reset filters?)$/i });
    await expect(reset).toHaveCount(1);
    await reset.click();
    await expect(overviewUi.dots(page)).toHaveCount(2);
    await expect(page).toHaveURL((url) => url.search === '');
    await expect(homeUi.questionSearch(page)).toHaveValue('');
  },
);

test(
  'UX12-FILTER-AC10 a legacy retry link reads as the 다시 풀기 status chip',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, ws, created } = await ownerHome(page, workspaceFactory, 'ux12-filter-10', 2);
    const [first] = created;
    if (!first) throw new Error('no question');
    await answerCorrectly(owner, first);
    await setMyState(owner, first.id, { needs_retry: true });

    await page.goto(`${homePath(ws.id)}?retry=true`);
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await openStatusFilters(page);
    await expect(statusChip(page, 'retry')).toHaveAttribute('aria-pressed', 'true');
    await expect(statusChip(page, 'unseen')).toHaveAttribute('aria-pressed', 'false');

    await statusChip(page, 'unseen').click();
    await expect(overviewUi.dots(page)).toHaveCount(2);
    await expect(page).toHaveURL(
      (url) => !url.searchParams.has('retry') && url.searchParams.getAll('status').length === 2,
    );
  },
);
