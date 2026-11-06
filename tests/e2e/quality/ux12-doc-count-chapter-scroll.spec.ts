// UX12-CHAPTERSCROLL (docs/screens/ux12-doc-count-chapter-scroll.md): 문서 N counts what 문서 관리
// lists, whatever the PDF's kind, and a list portalled out of a modal panel scrolls by touch and
// wheel.
//
// Touch: Playwright has no swipe API. Both engines get synthetic pointer + touch events on the
// element under the finger (WebKit has no Touch constructor, so the points are plain objects); a
// cancelled touchmove is one iOS Safari never turns into scrolling, so "scrolls" is asserted as
// "none cancelled". Chromium also gets a real gesture over CDP, asserting the offsets. No real iPad
// is covered: see the 확인하지 못한 것 note in the spec.

import type { Locator, Page } from '@playwright/test';
import { askUi, openAskPanel, openComposer, seedAskBook } from '../fixtures/ask.ts';
import { redistUi } from '../fixtures/chapter-redistribution.ts';
import { seedBookChapters } from '../fixtures/db.ts';
import { uploadPdf, uploadReadyBook, waitForJob } from '../fixtures/documents.ts';
import { createNumberedQuestions, questionPaper } from '../fixtures/questions.ts';
import {
  chapterPickerUi,
  docUi,
  expect,
  homePath,
  homeUi,
  signInAs,
  test,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

/** Wide enough for the popover (not the sheet), with touch: an iPad in landscape. */
const TABLET = { viewport: { width: 1024, height: 768 }, hasTouch: true } as const;

/**
 * Touches the middle of `target`, moves the finger by each of `path` (px from the touch), lifts it.
 * Returns how many touchmoves the page cancelled.
 */
async function swipe(page: Page, target: Locator, path: readonly number[]): Promise<number> {
  const box = await target.boundingBox();
  if (!box) throw new Error('swipe target is not visible');
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  return page.evaluate(
    ({ x, y, path }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) throw new Error('nothing under the finger');
      const pointer = (type: string, py: number) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerType: 'touch',
            pointerId: 7,
            isPrimary: true,
            clientX: x,
            clientY: py,
          }),
        );
      const touch = (type: string, py: number) => {
        const event = new TouchEvent(type, { bubbles: true, cancelable: true, composed: true });
        const point = { identifier: 1, target: el, clientX: x, clientY: py, pageX: x, pageY: py };
        const active = type === 'touchend' ? [] : [point];
        Object.defineProperty(event, 'touches', { value: active });
        Object.defineProperty(event, 'targetTouches', { value: active });
        Object.defineProperty(event, 'changedTouches', { value: [point] });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      };
      pointer('pointerdown', y);
      touch('touchstart', y);
      let cancelled = 0;
      for (const dy of path) {
        pointer('pointermove', y + dy);
        if (touch('touchmove', y + dy)) cancelled += 1;
      }
      const end = y + (path.at(-1) ?? 0);
      pointer('pointerup', end);
      touch('touchend', end);
      return cancelled;
    },
    { x, y, path },
  );
}

/** Chromium only: a real touch gesture over `target`; `dy` is the finger travel. */
async function realSwipe(page: Page, target: Locator, dy: number): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('swipe target is not visible');
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  const steps = 10;
  for (let i = 1; i <= steps; i += 1) {
    await page.waitForTimeout(16);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y + (dy * i) / steps }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const scrollTop = (el: Locator) => el.evaluate((node) => node.scrollTop);

const toEnd = (el: Locator) =>
  el.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });

async function wheelOver(page: Page, target: Locator, dy: number): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('wheel target is not visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, dy);
}

test(
  'UX12-CHAPTERSCROLL-AC01 문서 N counts every PDF of 문서 관리, a question paper too',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-doc-count');
    const ws = await workspaceFactory.create(owner);
    await uploadReadyBook(owner, ws.id, 'book-ko');
    const uploaded = await uploadPdf(owner, ws.id, questionPaper(), 'question_paper');
    await waitForJob(owner, uploaded.jobId);

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    const count = homeUi.documentsButton(page);
    await expect(count).toHaveText(/문서\s*2$/);

    await homeUi.openDocuments(page);
    const dialog = homeUi.documentsDialog(page);
    await expect(docUi.item(page, /book-ko/)).toBeVisible();
    await expect(docUi.item(page, /questions-ko/)).toBeVisible();
    await expect(
      dialog.getByRole('list', { name: /문서 목록|documents/i }).getByRole('listitem'),
    ).toHaveCount(2);

    const paperRow = docUi.item(page, /questions-ko/);
    await paperRow.getByRole('button', { name: /삭제|delete/i }).click();
    const confirm = page.getByRole('alertdialog', { name: /삭제|delete/i });
    await confirm.getByRole('button', { name: /^(삭제|delete)$/i }).click();
    await expect(docUi.item(page, /questions-ko/)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(count).toHaveText(/문서\s*1$/);
  },
);

test.describe('a list in a floating layer over a modal panel', () => {
  test.use(TABLET);

  test(
    'UX12-CHAPTERSCROLL-AC02 the chapter picker in a modal dialog scrolls by touch and wheel',
    { tag: '@infra' },
    async ({ page, workspaceFactory, browserName }) => {
      const owner = await workspaceFactory.member('ux12-chapter-scroll');
      const ws = await workspaceFactory.create(owner);
      const bookId = await uploadReadyBook(owner, ws.id, 'book-ko');
      seedBookChapters(bookId, 40);
      await createNumberedQuestions(owner, ws.id, 'ux12-chapter-scroll', 1);
      await signInAs(page, owner.user);
      await page.goto(homePath(ws.id));
      await homeUi.openMenu(page);
      await redistUi.menuItem(page).click();
      const dialog = redistUi.dialog(page);
      await expect(dialog).toBeVisible();

      await redistUi.target(dialog).click();
      const tree = page.getByRole('tree');
      const row = chapterPickerUi.row(page, '챕터 없음');
      await expect(row).toBeVisible();
      await expect
        .poll(() => tree.evaluate((el) => el.scrollHeight - el.clientHeight))
        .toBeGreaterThan(100);
      expect(await scrollTop(tree)).toBe(0);

      // The list opens at its top: a first move of nothing, or back up, must not end the swipe.
      expect(await swipe(page, row, [0, 0.4, -30, -90])).toBe(0);
      await expect(tree).toBeVisible();

      if (browserName === 'chromium') {
        await realSwipe(page, row, -160);
        await expect.poll(() => scrollTop(tree)).toBeGreaterThan(0);
      }

      await tree.evaluate((el) => {
        el.scrollTop = 0;
      });
      const panelScroll = () =>
        dialog.evaluate((el) => [...el.querySelectorAll('*')].map((n) => n.scrollTop).join());
      const before = await panelScroll();
      await wheelOver(page, tree, 240);
      await expect.poll(() => scrollTop(tree)).toBeGreaterThan(0);
      expect(await panelScroll()).toBe(before);

      await toEnd(tree);
      expect(await swipe(page, tree, [-40, -80]), 'past the end it stays contained').toBe(2);
      await expect(tree).toBeVisible();
    },
  );

  test(
    'UX12-CHAPTERSCROLL-AC03 a long non-modal popover over a modal panel scrolls by touch and wheel',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const owner = await workspaceFactory.member('ux12-popover-scroll');
      const ws = await workspaceFactory.create(owner);
      await seedAskBook(owner, ws.id);
      await signInAs(page, owner.user);
      await page.goto(homePath(ws.id));
      const panel = await openAskPanel(page);
      await openComposer(panel);
      await askUi.scopeButton(panel).click();
      const popover = askUi.scopePopover(page);
      await expect(popover).toBeVisible();

      // Data-independent overflow: the popover itself becomes the long list.
      await popover.evaluate((el) => {
        el.style.maxHeight = '200px';
        el.style.overflowY = 'auto';
        const filler = document.createElement('div');
        filler.setAttribute('aria-hidden', 'true');
        filler.style.height = '1200px';
        el.append(filler);
      });
      await expect
        .poll(() => popover.evaluate((el) => el.scrollHeight - el.clientHeight))
        .toBeGreaterThan(100);

      await wheelOver(page, popover, 120);
      await expect.poll(() => scrollTop(popover)).toBeGreaterThan(0);

      await popover.evaluate((el) => {
        el.scrollTop = 0;
      });
      expect(await swipe(page, popover, [-30, -90])).toBe(0);
      await toEnd(popover);
      expect(await swipe(page, popover, [-40, -80]), 'past the end it stays contained').toBe(2);
    },
  );
});
