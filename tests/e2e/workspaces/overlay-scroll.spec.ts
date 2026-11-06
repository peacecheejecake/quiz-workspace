// UX9-SCROLL — swiping or wheeling over an open overlay never scrolls the page underneath
// (user report 2026-11-02, iOS Safari). Overlays: a centered modal dialog (workspace 만들기), a
// floating dialog (문서 관리 — modal since UX9-MODAL, HOMEDLG-01) and a modal side panel (the question
// viewer). A modal locks the page while it is open, so the page is made scrollable
// (and scrolled) before the overlay opens.
//
// Touch: Playwright has no swipe API. Every swipe is dispatched twice:
// - as synthetic TouchEvents (both engines) at the element under the finger. A touchmove the page
//   cancels (preventDefault) is one iOS Safari never turns into scrolling, so "no chaining" is
//   asserted as "every touchmove of the gesture was cancelled" and "the overlay still scrolls" as
//   "none was". WebKit has no Touch constructor (like Safari), so the touch points are plain
//   objects on the event's touch lists.
// - in Chromium also as a real touch gesture (CDP Input.dispatchTouchEvent: touchStart, timed
//   touchMoves, touchEnd), asserting the page's and the overlay scroller's actual offsets.
//   Input.synthesizeScrollGesture is not used: on Linux Chromium (CI) it fires pointermoves but
//   never starts a scroll, so the "overlay still scrolls" half could not pass there.
// Wheel (desktop): real `mouse.wheel` scrolling in both engines.
//
// Data-independent scroll ranges: the page gets a tall spacer after its content and the overlay
// scroller a tall filler, so the page and the overlay can always scroll however little data the
// per-test workspace holds.
import type { Locator, Page } from '@playwright/test';
import { askUi } from '../fixtures/ask.ts';
import {
  createQuestion,
  expect,
  homeUi,
  mcqInput,
  overviewPath,
  overviewUi,
  signInAs,
  test,
  wsUi,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const PHONE = { viewport: { width: 390, height: 664 }, hasTouch: true } as const;

/**
 * Opens the home once its header is final: `AI 질문` mounts after the ask state loads and, on a
 * phone, wraps the header onto a new row, which would move a page already scrolled by 44px.
 */
async function openSettledHome(page: Page, workspaceId: string): Promise<void> {
  await page.goto(overviewPath(workspaceId));
  await expect(homeUi.documentsButton(page)).toBeVisible();
  await expect(askUi.headerButton(page)).toBeVisible();
}

/** Makes the page taller than the viewport and scrolls it to `y`. */
async function makePageScrollable(page: Page, y = 400): Promise<void> {
  await page.evaluate((top) => {
    const spacer = document.createElement('div');
    spacer.setAttribute('aria-hidden', 'true');
    spacer.style.height = '4000px';
    document.body.append(spacer);
    window.scrollTo(0, top);
  }, y);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(y);
}

/** Opens 문서 관리 from the home: the `문서 N` button is sticky, so this never moves the page. */
async function openDocumentsInPlace(page: Page): Promise<Locator> {
  await homeUi.openDocuments(page);
  const dialog = homeUi.documentsDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The overlay's own scroller (the vertically scrolling body), made taller than its viewport. */
async function overlayScroller(dialog: Locator): Promise<Locator> {
  const marker = `ux9-scroll-${Math.random().toString(36).slice(2)}`;
  await dialog.evaluate((root, name) => {
    const scroller = Array.from(root.querySelectorAll<HTMLElement>('*')).find((el) =>
      /^(auto|scroll)$/.test(getComputedStyle(el).overflowY),
    );
    if (!scroller) throw new Error('overlay has no vertical scroller');
    scroller.setAttribute('data-e2e-scroller', name);
    const filler = document.createElement('div');
    filler.setAttribute('aria-hidden', 'true');
    filler.style.height = '3000px';
    scroller.append(filler);
  }, marker);
  const scroller = dialog.locator(`[data-e2e-scroller="${marker}"]`);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(100);
  return scroller;
}

async function scrollTo(scroller: Locator, where: 'top' | 'middle' | 'bottom'): Promise<number> {
  return scroller.evaluate((el, at) => {
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = at === 'top' ? 0 : at === 'bottom' ? max : Math.round(max / 2);
    return el.scrollTop;
  }, where);
}

interface Swipe {
  /** Synthetic touchmoves dispatched / cancelled by the page (both engines). */
  moves: number;
  cancelled: number;
  /** Chromium only (real touch gesture): change of window.scrollY and of the scroller offset. */
  pageMoved: number | null;
  scrollerMoved: number | null;
}

/** Frames of the real touch gesture (Chromium): one touchMove per ~16 ms. */
const TOUCH_STEPS = 10;

/**
 * Swipes vertically on the middle of `target`: `dy` is the finger travel (negative = finger moves
 * up, which scrolls content down).
 */
async function swipe(
  page: Page,
  target: Locator,
  dy: number,
  scroller?: Locator,
  browserName?: string,
): Promise<Swipe> {
  const box = await target.boundingBox();
  if (!box) throw new Error('swipe target is not visible');
  const x = Math.round(box.x + Math.min(box.width / 2, 120));
  const y = Math.round(box.y + box.height / 2);

  const synthetic = await page.evaluate(
    ({ x, y, dy }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) throw new Error('nothing under the finger');
      const fire = (type: string, py: number) => {
        const event = new TouchEvent(type, { bubbles: true, cancelable: true, composed: true });
        const touch = { identifier: 1, target: el, clientX: x, clientY: py, pageX: x, pageY: py };
        const active = type === 'touchend' ? [] : [touch];
        Object.defineProperty(event, 'touches', { value: active });
        Object.defineProperty(event, 'targetTouches', { value: active });
        Object.defineProperty(event, 'changedTouches', { value: [touch] });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      };
      fire('touchstart', y);
      let cancelled = 0;
      const steps = 6;
      for (let i = 1; i <= steps; i += 1)
        if (fire('touchmove', y + (dy * i) / steps)) cancelled += 1;
      fire('touchend', y + dy);
      return { moves: steps, cancelled };
    },
    { x, y, dy },
  );

  if (browserName !== 'chromium') return { ...synthetic, pageMoved: null, scrollerMoved: null };
  const selector = scroller ? await scrollerSelector(scroller) : null;
  const offsets = () =>
    page.evaluate(
      (sel) => ({
        page: window.scrollY,
        scroller: sel ? (document.querySelector(sel)?.scrollTop ?? 0) : 0,
      }),
      selector,
    );
  const before = await offsets();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= TOUCH_STEPS; i += 1) {
    await page.waitForTimeout(16);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y + (dy * i) / TOUCH_STEPS }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  // Let the compositor's last scroll frame land before reading the offsets.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const after = await offsets();
  return {
    ...synthetic,
    pageMoved: after.page - before.page,
    scrollerMoved: after.scroller - before.scroller,
  };
}

async function scrollerSelector(scroller: Locator): Promise<string> {
  const name = await scroller.getAttribute('data-e2e-scroller');
  return `[data-e2e-scroller="${name}"]`;
}

/** The page underneath did not move: every touchmove cancelled, and (Chromium) no real scroll. */
function expectContained(result: Swipe): void {
  expect(result.cancelled, 'every touchmove over the overlay is cancelled').toBe(result.moves);
  if (result.pageMoved !== null) expect(result.pageMoved, 'page scroll offset').toBe(0);
}

/** The overlay's own scroller still scrolls: no touchmove cancelled, and (Chromium) it moved. */
function expectOverlayScrolls(result: Swipe): void {
  expect(result.cancelled, 'touchmoves that scroll the overlay are not cancelled').toBe(0);
  if (result.scrollerMoved !== null) expect(result.scrollerMoved).toBeGreaterThan(0);
  if (result.pageMoved !== null) expect(result.pageMoved, 'page scroll offset').toBe(0);
}

/** Header swipes both ways, scroller swipes past both ends, and one swipe that scrolls inside. */
async function expectSwipesContained(
  page: Page,
  dialog: Locator,
  browserName: string,
): Promise<void> {
  const header = dialog.getByRole('heading').first();
  const scroller = await overlayScroller(dialog);

  expectContained(await swipe(page, header, -160, undefined, browserName));

  await scrollTo(scroller, 'bottom');
  expectContained(await swipe(page, scroller, -160, scroller, browserName));
  await scrollTo(scroller, 'top');
  expectContained(await swipe(page, scroller, 160, scroller, browserName));

  await scrollTo(scroller, 'middle');
  expectOverlayScrolls(await swipe(page, scroller, -160, scroller, browserName));

  // Last: pulling the header down dismisses the overlay (UX12 DESIGN-3).
  expectContained(await swipe(page, header, 160, undefined, browserName));
}

test.describe('phone (touch)', () => {
  test.use(PHONE);

  test(
    'UX9-SCROLL-AC01 swiping over an open modal dialog (header or its scroller at an end) never scrolls the page',
    { tag: '@infra' },
    async ({ page, workspaceFactory, browserName }) => {
      const member = await workspaceFactory.member('ux9-scroll-ac01');
      await signInAs(page, member.user);
      await page.goto('/workspaces');
      await makePageScrollable(page);
      await wsUi.createButton(page).click();
      const dialog = wsUi.createDialog(page);
      await expect(dialog).toBeVisible();
      await expectSwipesContained(page, dialog, browserName);
    },
  );

  test(
    'UX9-SCROLL-AC02 swiping over the modal 문서 관리 dialog (header or its scroller at an end) never scrolls the page',
    { tag: '@infra' },
    async ({ page, workspaceFactory, browserName }) => {
      const owner = await workspaceFactory.member('ux9-scroll-ac02');
      const ws = await workspaceFactory.create(owner);
      await signInAs(page, owner.user);
      await openSettledHome(page, ws.id);
      await makePageScrollable(page);
      const dialog = await openDocumentsInPlace(page);
      await expectSwipesContained(page, dialog, browserName);
    },
  );

  test(
    'UX9-SCROLL-AC03 swiping over the question side panel (header or its scroller at an end) never scrolls the page',
    { tag: '@infra' },
    async ({ page, workspaceFactory, browserName }) => {
      const owner = await workspaceFactory.member('ux9-scroll-ac03');
      const ws = await workspaceFactory.create(owner);
      await createQuestion(owner, ws.id, {
        question_number: 1,
        ...mcqInput('UX9 스크롤 문제: 알맞은 것을 고르시오.', ['가', '나', '다', '라'], 1),
      });
      await signInAs(page, owner.user);
      await openSettledHome(page, ws.id);
      await makePageScrollable(page);
      await overviewUi.dot(page, 1).click();
      const panel = page
        .getByRole('dialog')
        .filter({ has: page.getByRole('button', { name: /^(패널 닫기|close panel)$/i }) });
      await expect(panel).toBeVisible();
      await expectSwipesContained(page, panel, browserName);
    },
  );
});

test(
  'UX9-SCROLL-AC04 the mouse wheel over the modal 문서 관리 dialog never scrolls the page, nor over its backdrop; closed, the page scrolls again',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux9-scroll-ac04');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await openSettledHome(page, ws.id);
    await makePageScrollable(page);
    const dialog = await openDocumentsInPlace(page);
    const scroller = await overlayScroller(dialog);
    const scrollY = () => page.evaluate(() => window.scrollY);

    const wheelOver = async (target: Locator, dy: number) => {
      const box = await target.boundingBox();
      if (!box) throw new Error('wheel target is not visible');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, dy);
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
    };

    await wheelOver(dialog.getByRole('heading').first(), 300);
    expect(await scrollY(), 'wheel down over the header').toBe(400);
    await wheelOver(dialog.getByRole('heading').first(), -300);
    expect(await scrollY(), 'wheel up over the header').toBe(400);

    await scrollTo(scroller, 'bottom');
    await wheelOver(scroller, 300);
    expect(await scrollY(), 'wheel down over the scroller at its end').toBe(400);

    await scrollTo(scroller, 'middle');
    const middle = await scroller.evaluate((el) => el.scrollTop);
    await wheelOver(scroller, 200);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(middle);
    expect(await scrollY(), 'wheel scrolling the dialog body').toBe(400);

    // Modal (UX9): the backdrop beside the dialog does not scroll the page either…
    const box = await dialog.boundingBox();
    if (!box) throw new Error('dialog is not visible');
    await page.mouse.move(box.x - 40, 300);
    await page.mouse.wheel(0, 200);
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    expect(await scrollY(), 'wheel over the backdrop').toBe(400);
    // …and once the dialog is closed the page scrolls again.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.mouse.wheel(0, 200);
    await expect.poll(scrollY).toBeGreaterThan(400);
  },
);
