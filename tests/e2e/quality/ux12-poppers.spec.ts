// UX12 DESIGN-2 — poppers keep a safe margin from the viewport edge, and pressing an open popper's
// trigger again closes it (user feedback 2026-11-06).
//
// Presses are real input at the trigger's coordinates (`mouse.click`, `touchscreen.tap`), not
// locator actions: an open layer may legitimately cover or disable the page, and whatever receives
// the press is exactly what is being tested.
import type { Locator, Page } from '@playwright/test';
import {
  createQuestion,
  expect,
  homePath,
  homeUi,
  mcqInput,
  openContentSearch,
  openSearchOptions,
  overviewPath,
  overviewUi,
  signInAs,
  test,
  wsUi,
  type E2EFixtures,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const SAFE_MARGIN = 16;
const LONG_TEXT = '화면 가장자리 여백을 확인하는 아주 긴 도움말 문구입니다. '.repeat(6);
/** Long enough for a late event of the press (release click, focus return) to have reopened it. */
const SETTLE_MS = 400;

type Edge = 'left' | 'right';
type Press = 'mouse' | 'touch';

/** Moves `trigger` onto the viewport edge without changing the page's layout. */
async function pinToEdge(trigger: Locator, edge: Edge): Promise<void> {
  await trigger.evaluate((element, side) => {
    const rect = element.getBoundingClientRect();
    const dx = side === 'left' ? -rect.left : window.innerWidth - rect.right;
    (element as HTMLElement).style.transform = `translateX(${dx}px)`;
  }, edge);
}

async function focusInPlace(trigger: Locator): Promise<void> {
  await trigger.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
}

async function expectSafeMargin(page: Page, surface: Locator): Promise<void> {
  await expect(surface).toBeVisible();
  const width = page.viewportSize()?.width ?? 0;
  await expect
    .poll(async () => {
      const box = await surface.boundingBox();
      return box ? Math.round(Math.min(box.x, width - (box.x + box.width))) : -1;
    })
    .toBeGreaterThanOrEqual(SAFE_MARGIN);
}

async function press(page: Page, trigger: Locator, how: Press): Promise<void> {
  const box = await trigger.boundingBox();
  if (!box) throw new Error('the trigger has no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (how === 'mouse') await page.mouse.click(x, y);
  else await page.touchscreen.tap(x, y);
}

/** Open → press again closes and it stays closed → a third press opens it again. */
async function expectToggles(
  page: Page,
  trigger: Locator,
  surface: Locator,
  how: Press,
): Promise<void> {
  await press(page, trigger, how);
  await expect(surface).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

  await press(page, trigger, how);
  await expect(surface).toBeHidden();
  await page.waitForTimeout(SETTLE_MS);
  await expect(surface).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  await press(page, trigger, how);
  await expect(surface).toBeVisible();
  await page.waitForTimeout(SETTLE_MS);
  await expect(surface).toBeVisible();

  await press(page, trigger, how);
  await expect(surface).toBeHidden();
}

const userMenuTrigger = (page: Page) => page.getByRole('button', { name: /^(계정|account)/i });
const userMenu = (page: Page) => page.getByRole('dialog', { name: /^(계정 메뉴|account menu)$/i });

for (const edge of ['left', 'right'] as const) {
  test(
    `UX12-POPPERS-AC01 tooltip keeps the margin at the ${edge} edge`,
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const owner = await workspaceFactory.member('ux12-pop-01');
      const ws = await workspaceFactory.create(owner);
      await signInAs(page, owner.user);
      await page.goto(homePath(ws.id));
      const link = homeUi.contentSearchLink(page);
      await expect(link).toBeVisible();
      await pinToEdge(link, edge);
      await focusInPlace(link);
      await expectSafeMargin(page, page.getByRole('tooltip'));
    },
  );

  test(
    `UX12-POPPERS-AC03 question preview keeps the margin at the ${edge} edge`,
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const owner = await workspaceFactory.member('ux12-pop-03');
      const ws = await workspaceFactory.create(owner);
      await createQuestion(owner, ws.id, {
        question_number: 1,
        ...mcqInput('UX12 미리보기 문제: 알맞은 것을 고르시오.', ['가', '나', '다', '라'], 1),
      });
      await signInAs(page, owner.user);
      await page.goto(overviewPath(ws.id));
      const dot = overviewUi.dot(page, 1);
      await expect(dot).toBeVisible();
      await pinToEdge(dot, edge);
      await focusInPlace(dot);
      await expectSafeMargin(page, page.getByRole('tooltip'));
    },
  );
}

test.describe('narrow viewport', () => {
  test.use({ viewport: { width: 300, height: 640 } });

  test(
    'UX12-POPPERS-AC02 long tooltip fits the narrow viewport with both margins',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const owner = await workspaceFactory.member('ux12-pop-02');
      const ws = await workspaceFactory.create(owner);
      await signInAs(page, owner.user);
      await page.goto(homePath(ws.id));
      const link = homeUi.contentSearchLink(page);
      await expect(link).toBeVisible();
      await focusInPlace(link);
      const surface = page.getByRole('tooltip');
      await expect(surface).toBeVisible();
      await surface.evaluate((element, text) => {
        element.textContent = text;
      }, LONG_TEXT);
      await expectSafeMargin(page, surface);
      const box = await surface.boundingBox();
      expect(box?.width ?? Infinity).toBeLessThanOrEqual(300 - 2 * SAFE_MARGIN);
    },
  );
});

type Factory = E2EFixtures['workspaceFactory'];

async function questionMenuToggles(page: Page, factory: Factory, how: Press): Promise<void> {
  const owner = await factory.member('ux12-pop-menu');
  const ws = await factory.create(owner);
  await signInAs(page, owner.user);
  await page.goto(homePath(ws.id));
  const trigger = homeUi.questionMenuButton(page);
  await expect(trigger).toBeVisible();
  await expectToggles(page, trigger, homeUi.questionMenu(page), how);
}

async function listMenuToggles(page: Page, factory: Factory, how: Press): Promise<void> {
  const owner = await factory.member('ux12-pop-list');
  const ws = await factory.create(owner);
  await signInAs(page, owner.user);
  await page.goto('/workspaces');
  const trigger = wsUi.moreButton(wsUi.item(wsUi.tabPanel(page), ws.name));
  await expect(trigger).toBeVisible();
  await expectToggles(page, trigger, page.getByRole('menu'), how);
}

test(
  'UX12-POPPERS-AC04 question menu closes on a second mouse press',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await questionMenuToggles(page, workspaceFactory, 'mouse');
  },
);

test(
  'UX12-POPPERS-AC04 workspace list menu closes on a second mouse press',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await listMenuToggles(page, workspaceFactory, 'mouse');
  },
);

test.describe('touch menus', () => {
  test.use({ hasTouch: true });

  test(
    'UX12-POPPERS-AC05 question menu closes on a second tap',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await questionMenuToggles(page, workspaceFactory, 'touch');
    },
  );

  test(
    'UX12-POPPERS-AC05 workspace list menu closes on a second tap',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await listMenuToggles(page, workspaceFactory, 'touch');
    },
  );
});

for (const how of ['mouse', 'touch'] as const) {
  test.describe(`trigger re-press (${how})`, () => {
    test.use(how === 'touch' ? { hasTouch: true } : {});

    test(
      `UX12-POPPERS-AC06 user menu popover closes on a second ${how} press`,
      { tag: '@infra' },
      async ({ page, workspaceFactory }) => {
        const owner = await workspaceFactory.member('ux12-pop-user');
        const ws = await workspaceFactory.create(owner);
        await signInAs(page, owner.user);
        await page.goto(homePath(ws.id));
        const trigger = userMenuTrigger(page);
        await expect(trigger).toBeVisible();
        await expectToggles(page, trigger, userMenu(page), how);
      },
    );

    test(
      `UX12-POPPERS-AC06 search settings popover closes on a second ${how} press`,
      { tag: '@infra' },
      async ({ page, workspaceFactory }) => {
        const owner = await workspaceFactory.member('ux12-pop-settings');
        const ws = await workspaceFactory.create(owner);
        await signInAs(page, owner.user);
        await page.goto(homePath(ws.id));
        await openContentSearch(page);
        const trigger = homeUi.searchSettingsButton(page, 'body');
        await expect(trigger).toBeVisible();
        await expectToggles(page, trigger, homeUi.searchSettings(page, 'body'), how);
      },
    );

    test(
      `UX12-POPPERS-AC07 select closes on a second ${how} press and keeps its value`,
      { tag: '@infra' },
      async ({ page, workspaceFactory }) => {
        const owner = await workspaceFactory.member('ux12-pop-select');
        const ws = await workspaceFactory.create(owner);
        await signInAs(page, owner.user);
        await page.goto(homePath(ws.id));
        const settings = await openSearchOptions(page, 'body');
        const combobox = settings.getByRole('combobox', { name: /^(문서|document)$/i });
        await expect(combobox).toBeVisible();
        // An open Select hides the page from the accessibility tree: keep the trigger by its id.
        const trigger = page.locator(`[id="${await combobox.getAttribute('id')}"]`);
        const before = await trigger.textContent();
        await expectToggles(page, trigger, page.getByRole('listbox'), how);
        await expect(trigger).toHaveText(before ?? '');
        // The Select's own press never dismisses the popover it lives in.
        await expect(trigger).toBeVisible();
      },
    );
  });
}
