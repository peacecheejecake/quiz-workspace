// UX12-KEYBOARD (docs/screens/ux12-keyboard.md). Playwright cannot raise a real virtual keyboard, so
// these tests overwrite `window.visualViewport` with the values iOS Safari reports and check that
// the surfaces land in the visible area. They prove the CSS wiring only: real-device checks on iOS
// Safari and Android Chrome stay part of the Task's DoD.
import type { Locator, Page } from '@playwright/test';
import { askPath, askUi, openComposer, seedAskBook } from '../fixtures/ask.ts';
import {
  createQuestion,
  expect,
  homeUi,
  mcqInput,
  overviewPath,
  overviewUi,
  panelUi,
  signInAs,
  test,
  wsUi,
  type E2EFixtures,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 375, height: 667 } });

const LAYOUT_HEIGHT = 667;
/** A 300px keyboard, with Safari having panned the visual viewport down by 120px to show a field. */
const KEYBOARD = { height: 367, offsetTop: 120, scale: 1 };
const VISIBLE_BOTTOM = KEYBOARD.offsetTop + KEYBOARD.height;
const RETURN_LABEL = /보던 문제로 돌아가기|return to/i;
const RETURN_BAR = '[data-app-global-control="practice-return"] > div';

interface MockViewport {
  height: number;
  offsetTop: number;
  scale: number;
}

async function mockVisualViewport(page: Page) {
  await page.addInitScript(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const mock: Partial<MockViewport> = {};
    (window as unknown as { __viewport: Partial<MockViewport> }).__viewport = mock;
    for (const key of ['height', 'offsetTop', 'scale'] as const) {
      const real = viewport[key];
      Object.defineProperty(viewport, key, { configurable: true, get: () => mock[key] ?? real });
    }
  });
}

const setViewport = (page: Page, state: MockViewport) =>
  page.evaluate((next) => {
    Object.assign((window as unknown as { __viewport: MockViewport }).__viewport, next);
    window.visualViewport?.dispatchEvent(new Event('resize'));
  }, state);

const closeKeyboard = (page: Page) =>
  setViewport(page, { height: LAYOUT_HEIGHT, offsetTop: 0, scale: 1 });

async function box(target: Locator) {
  const value = await target.boundingBox();
  if (!value) throw new Error('the element has no box');
  return value;
}

/** Runs `check` until it holds: surfaces animate in, so one reading can catch them mid-way. */
const expectBox = (
  target: Locator,
  check: (value: Awaited<ReturnType<typeof box>>) => void,
): Promise<void> =>
  expect(async () => {
    check(await box(target));
  }).toPass({ timeout: 3000 });

async function questionPage(
  page: Page,
  workspaceFactory: E2EFixtures['workspaceFactory'],
  label: string,
) {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  await createQuestion(owner, ws.id, {
    question_number: 1,
    ...mcqInput('UX12 keyboard 문제: 알맞은 것을 고르시오.', ['가', '나', '다', '라'], 1),
  });
  await mockVisualViewport(page);
  await signInAs(page, owner.user);
  return { owner, workspaceId: ws.id };
}

test('UX12-KEYBOARD-AC01 the viewport meta asks the keyboard to resize the content', async ({
  page,
}) => {
  await page.goto('/login');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    'content',
    /interactive-widget=resizes-content/,
  );
});

test(
  'UX12-KEYBOARD-AC02 the header stays at the top of the visible area and the toolbar stays under it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { workspaceId } = await questionPage(page, workspaceFactory, 'ux12-keyboard-02');
    await page.goto(overviewPath(workspaceId));
    const header = page.getByRole('banner');
    const toolbarButton = homeUi.questionMenuButton(page);
    await expect(toolbarButton).toBeVisible();

    await setViewport(page, KEYBOARD);
    await expectBox(header, (frame) => expect(frame.y).toBeCloseTo(KEYBOARD.offsetTop, 0));
    const frame = await box(header);
    await expectBox(toolbarButton, (button) =>
      expect(button.y).toBeGreaterThanOrEqual(frame.y + frame.height),
    );
  },
);

test(
  'UX12-KEYBOARD-AC03 the AI 질문 panel sits on the keyboard with its composer in view',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-keyboard-03');
    const ws = await workspaceFactory.create(owner);
    await seedAskBook(owner, ws.id);
    await mockVisualViewport(page);
    await signInAs(page, owner.user);
    await page.goto(askPath(ws.id));
    const panel = askUi.panel(page);
    await expect(panel).toBeVisible();
    const input = await openComposer(panel);

    await setViewport(page, KEYBOARD);
    await expectBox(panel, (frame) => {
      expect(frame.y).toBeGreaterThanOrEqual(KEYBOARD.offsetTop);
      expect(frame.y + frame.height).toBeCloseTo(VISIBLE_BOTTOM, 0);
    });
    await expectBox(input, (field) => {
      expect(field.y).toBeGreaterThanOrEqual(KEYBOARD.offsetTop);
      expect(field.y + field.height).toBeLessThanOrEqual(VISIBLE_BOTTOM);
    });
  },
);

test(
  'UX12-KEYBOARD-AC04 a modal dialog fits inside the visible area',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await questionPage(page, workspaceFactory, 'ux12-keyboard-04');
    await page.goto('/workspaces');
    await wsUi.createButton(page).click();
    const dialog = wsUi.createDialog(page);
    await expect(dialog).toBeVisible();

    await setViewport(page, KEYBOARD);
    await expectBox(dialog, (frame) => {
      expect(frame.y).toBeGreaterThanOrEqual(KEYBOARD.offsetTop);
      expect(frame.y + frame.height).toBeLessThanOrEqual(VISIBLE_BOTTOM);
      const middle = KEYBOARD.offsetTop + KEYBOARD.height / 2;
      expect(Math.abs(frame.y + frame.height / 2 - middle)).toBeLessThanOrEqual(1);
    });
  },
);

test(
  'UX12-KEYBOARD-AC05 the return bar floats above the keyboard',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { workspaceId } = await questionPage(page, workspaceFactory, 'ux12-keyboard-05');
    await page.goto(overviewPath(workspaceId));
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await expect(panel).toBeVisible();
    await panelUi.close(panel).click();
    await expect(page.getByRole('button', { name: RETURN_LABEL })).toBeVisible();

    await setViewport(page, KEYBOARD);
    await expectBox(page.locator(RETURN_BAR), (bar) => {
      expect(bar.y).toBeGreaterThanOrEqual(KEYBOARD.offsetTop);
      expect(bar.y + bar.height).toBeLessThanOrEqual(VISIBLE_BOTTOM);
    });
  },
);

test(
  'UX12-KEYBOARD-AC06 closing the keyboard restores the layout and pinch-zoom is left alone',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { workspaceId } = await questionPage(page, workspaceFactory, 'ux12-keyboard-06');
    await page.goto(overviewPath(workspaceId));
    const header = page.getByRole('banner');
    await expect(overviewUi.dot(page, 1)).toBeVisible();

    await setViewport(page, KEYBOARD);
    await expectBox(header, (frame) => expect(frame.y).toBeCloseTo(KEYBOARD.offsetTop, 0));
    await closeKeyboard(page);
    await expectBox(header, (frame) => expect(frame.y).toBeCloseTo(0, 0));

    await setViewport(page, { ...KEYBOARD, scale: 2 });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect((await box(header)).y).toBeCloseTo(0, 0);
  },
);
