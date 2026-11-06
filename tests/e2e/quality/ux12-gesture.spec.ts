// UX12 DESIGN-3 — overlays follow the finger, leave with inertia or spring back; the return bar
// swipes away (user feedback 2026-11-06, decision D-2). Pointer events only: real-device feel
// cannot be judged here.
import type { Page } from '@playwright/test';
import { drag, expectSettled, line } from '../fixtures/overlay-drag.ts';
import {
  createQuestion,
  expect,
  homePath,
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

test.use({ storageState: { cookies: [], origins: [] } });
// The projects pin reduced motion, which turns tracking off.
test.beforeEach(({ page }) => page.emulateMedia({ reducedMotion: 'no-preference' }));

const PHONE = { viewport: { width: 390, height: 664 } } as const;
const RETURN_BAR = '[data-app-global-control="practice-return"] > div';

async function openHome(
  page: Page,
  workspaceFactory: E2EFixtures['workspaceFactory'],
  name: string,
) {
  const owner = await workspaceFactory.member(name);
  const ws = await workspaceFactory.create(owner);
  await signInAs(page, owner.user);
  await page.goto(overviewPath(ws.id));
  return { owner, ws };
}

async function openCreateDialog(
  page: Page,
  workspaceFactory: E2EFixtures['workspaceFactory'],
  name: string,
) {
  const member = await workspaceFactory.member(name);
  await signInAs(page, member.user);
  await page.goto('/workspaces');
  const opener = wsUi.createButton(page);
  await opener.click();
  const dialog = wsUi.createDialog(page);
  await expect(dialog).toBeVisible();
  return { opener, dialog };
}

test.describe('phone', () => {
  test.use(PHONE);

  test(
    'UX12-GESTURE-AC01 a centered dialog follows the finger down and leaves, focus back on its opener',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const { opener, dialog } = await openCreateDialog(page, workspaceFactory, 'ux12-gest-01');
      const seen = await drag(dialog.getByRole('heading').first(), [
        [0, 40],
        [0, 80],
        [0, 120],
      ]);
      expect(seen).toEqual(['0px 40px', '0px 80px', '0px 120px']);
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
    },
  );

  test(
    'UX12-GESTURE-AC02 on a phone a panel swipes down and its URL value goes',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await openHome(page, workspaceFactory, 'ux12-gest-02a');
      await homeUi.openDocuments(page);
      const panel = homeUi.documentsDialog(page);
      await expect(panel).toBeVisible();
      await expect(page).toHaveURL(/[?&]panel=/);
      const seen = await drag(panel.getByRole('heading').first(), line(0, 120));
      expect(seen.at(-1)).toBe('0px 120px');
      await expect(panel).toBeHidden();
      await expect(page).not.toHaveURL(/[?&]panel=/);
    },
  );

  test(
    'UX12-GESTURE-AC07 a modal sheet shows a grabber that starts the gesture',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await openHome(page, workspaceFactory, 'ux12-gest-07');
      await homeUi.openDocuments(page);
      const panel = homeUi.documentsDialog(page);
      const grabber = panel.locator(':scope > .header > .grabber');
      await expect(grabber).toBeVisible();
      const box = await grabber.boundingBox();
      const surface = await panel.boundingBox();
      if (!box || !surface) throw new Error('missing bounds');
      expect(Math.abs(box.x + box.width / 2 - (surface.x + surface.width / 2))).toBeLessThan(1);
      expect(box.y - surface.y).toBeLessThan(16);
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(grabber).toBeHidden();
      await page.setViewportSize(PHONE.viewport);
      await expect(grabber).toBeVisible();
      await drag(grabber, line(0, 120));
      await expect(panel).toBeHidden();
    },
  );
});

test(
  'UX12-GESTURE-AC02 on a wide screen a side panel leaves sideways and a centered dialog downwards',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await openHome(page, workspaceFactory, 'ux12-gest-02b');
    await homeUi.openDocuments(page);
    const panel = homeUi.documentsDialog(page);
    const header = panel.getByRole('heading').first();
    await expect(panel).toHaveAttribute('data-side', 'end');
    // A side panel does not follow a downward drag.
    expect(await drag(header, line(0, 120, 8))).toEqual(Array(8).fill(''));
    await expect(panel).toBeVisible();
    const seen = await drag(header, line(120, 0));
    expect(seen.at(-1)).toBe('120px');
    await expect(panel).toBeHidden();

    await page.goto('/workspaces');
    await wsUi.createButton(page).click();
    const dialog = wsUi.createDialog(page);
    await expect(dialog).toBeVisible();
    const down = await drag(dialog.getByRole('heading').first(), line(0, 120));
    expect(down.at(-1)).toBe('0px 120px');
    await expect(dialog).toBeHidden();
  },
);

test(
  'UX12-GESTURE-AC03 a drag starts on the title but not on header buttons or in the body',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { dialog } = await openCreateDialog(page, workspaceFactory, 'ux12-gest-03');
    const untouched = Array(4).fill('');
    const close = dialog.locator(':scope > .header').getByRole('button');
    expect(await drag(close, line(0, 120), { end: 'cancel' })).toEqual(untouched);
    expect(await drag(wsUi.nameField(dialog), line(0, 120))).toEqual(untouched);
    expect(await drag(dialog.locator(':scope > .body'), line(0, 120))).toEqual(untouched);
    await expect(dialog).toBeVisible();
    const seen = await drag(dialog.getByRole('heading').first(), line(0, 40), { end: 'cancel' });
    expect(seen.at(-1)).toBe('0px 40px');
  },
);

test(
  'UX12-GESTURE-AC04 short, opposite and cancelled drags spring back in place',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { dialog } = await openCreateDialog(page, workspaceFactory, 'ux12-gest-04');
    const header = dialog.getByRole('heading').first();

    const short = await drag(header, line(0, 40, 8), { pauseMs: 40 });
    expect(short.at(-1)).toBe('0px 40px');
    await expectSettled(dialog);

    const opposite = await drag(header, line(0, -200));
    const pulled = Number(/^0px (-?[\d.]+)px$/.exec(opposite.at(-1) ?? '')?.[1]);
    expect(pulled).toBeLessThan(0);
    expect(pulled).toBeGreaterThanOrEqual(-24);
    await expectSettled(dialog);

    await drag(header, line(0, 200), { end: 'cancel' });
    await expectSettled(dialog);
    await expect(dialog).toBeVisible();
  },
);

test(
  'UX12-GESTURE-AC05 a dialog with unsaved input springs back and keeps it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { ws } = await openHome(page, workspaceFactory, 'ux12-gest-05');
    await page.goto(homePath(ws.id, 'panel=question-create'));
    const editor = page.getByRole('dialog', { name: /^(문제 등록|new question)$/i });
    await expect(editor).toBeVisible();
    const stem = editor.getByRole('textbox').first();
    await stem.fill('저장하지 않은 문항');
    const seen = await drag(editor.getByRole('heading').first(), line(0, 160));
    expect(seen.at(-1)).toBe('0px 160px');
    await expectSettled(editor);
    await expect(editor).toBeVisible();
    await expect(stem).toHaveValue('저장하지 않은 문항');
  },
);

test(
  'UX12-GESTURE-AC06 reduced motion does not track and closes at once',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { opener, dialog } = await openCreateDialog(page, workspaceFactory, 'ux12-gest-06');
    const seen = await drag(dialog.getByRole('heading').first(), line(0, 120));
    expect(seen).toEqual(Array(4).fill(''));
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  },
);

test(
  'UX12-GESTURE-AC08 the return bar follows a drag from its button and swipes away like its close button',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, ws } = await openHome(page, workspaceFactory, 'ux12-gest-08');
    await createQuestion(owner, ws.id, {
      question_number: 1,
      ...mcqInput('UX12 복귀 bar 문제: 알맞은 것을 고르시오.', ['가', '나', '다', '라'], 1),
    });
    await page.reload();
    const leavePractice = async () => {
      await overviewUi.dot(page, 1).click();
      const panel = panelUi.numbered(page, 1);
      await expect(panel).toBeVisible();
      await panelUi.close(panel).click();
    };
    await leavePractice();
    const button = page.getByRole('button', { name: '보던 문제로 돌아가기' });
    await expect(button).toBeVisible();

    // A short drag springs back, and its release click is not a press.
    const short = await drag(button, line(0, 30, 6), {
      surface: RETURN_BAR,
      pauseMs: 40,
      click: true,
    });
    expect(short.at(-1)).toBe('0px 30px');
    await expect(button).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]question=/);
    await expectSettled(page.locator(RETURN_BAR));

    const seen = await drag(button, line(0, 100), { surface: RETURN_BAR, click: true });
    expect(seen.at(-1)).toBe('0px 100px');
    await expect(button).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]question=/);

    await leavePractice();
    await expect(button).toBeVisible();
  },
);
