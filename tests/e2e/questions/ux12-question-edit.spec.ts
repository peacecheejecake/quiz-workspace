// UX12 VIEW-3 — dragging an MCQ option by its handle and multi-line option text, in the question
// editor shared with the draft and mock exam editors: docs/screens/ux12-question-edit.md.
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import {
  choosePanelManage,
  createQuestion,
  expect,
  getQuestion,
  homePath,
  mcqInput,
  overviewUi,
  panelUi,
  questionFormUi,
  signInAs,
  test,
  type E2EFixtures,
  type Member,
  type Question,
} from '../fixtures/test.ts';

// Tall enough that every option fits in the dialog: drags start and end at measured positions.
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 1500 } });

const TEXTS = ['맞는 보기', '둘째 보기', '셋째 보기', '넷째 보기'] as const;

interface Seeded {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly question: Question;
}

async function seed(
  workspaceFactory: E2EFixtures['workspaceFactory'],
  label: string,
): Promise<Seeded> {
  const owner = await workspaceFactory.member(label);
  const workspace = await workspaceFactory.create(owner);
  const question = await createQuestion(owner, workspace.id, {
    question_number: 1,
    ...mcqInput(`QEDIT ${randomUUID().slice(0, 8)}`, TEXTS),
  });
  return { owner, workspaceId: workspace.id, question };
}

async function openPanel(page: Page, s: Seeded): Promise<Locator> {
  await page.goto(homePath(s.workspaceId));
  await expect(overviewUi.heatmap(page)).toBeVisible();
  await overviewUi.dot(page, 1).click();
  const panel = panelUi.numbered(page, 1);
  await expect(panel).toBeVisible();
  return panel;
}

async function openEditor(page: Page, s: Seeded): Promise<Locator> {
  await signInAs(page, s.owner.user);
  const panel = await openPanel(page, s);
  await choosePanelManage(page, panel, 'edit');
  const form = questionFormUi.form(page);
  await expect(form).toBeVisible();
  await expect(questionFormUi.option(form, 1)).toHaveValue(TEXTS[0]);
  return form;
}

const handle = (form: Locator, n: number) => form.locator('[data-option-handle]').nth(n - 1);
const dragPreview = (page: Page) => page.locator('[data-option-drag-preview]');

async function center(target: Locator): Promise<{ x: number; y: number }> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('target has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function expectOptionOrder(form: Locator, texts: readonly string[]): Promise<void> {
  for (const [i, text] of texts.entries()) {
    await expect(questionFormUi.option(form, i + 1)).toHaveValue(text);
  }
}

/** The order the server stores: ids travel with their text and the answer stays on its id. */
async function expectStoredOrder(s: Seeded, order: readonly number[]): Promise<void> {
  const original = s.question.revision.options;
  await expect
    .poll(async () => (await getQuestion(s.owner, s.question.id)).revision.options)
    .toEqual(order.map((i) => original[i]));
  const stored = await getQuestion(s.owner, s.question.id);
  expect(stored.revision.correct_option_ids).toEqual(s.question.revision.correct_option_ids);
}

async function expectCorrectWhenPicked(
  page: Page,
  s: Seeded,
  order: readonly string[],
): Promise<void> {
  const panel = await openPanel(page, s);
  await expect(panelUi.options(panel)).toHaveCount(order.length);
  for (const [i, text] of order.entries()) {
    await expect(panelUi.options(panel).nth(i)).toHaveAccessibleName(text);
  }
  await panelUi.option(panel, TEXTS[0]).check();
  await panelUi.submit(panel).click();
  await expect(panelUi.result(panel)).toContainText(/정답입니다|correct/i);
}

/** Pointer events with `pointerType: 'touch'`, a frame apart so React commits in between. */
async function touchDrag(from: Locator, to: { x: number; y: number }): Promise<void> {
  const start = await center(from);
  await from.evaluate(
    async (element, { start, to }) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const fire = (target: EventTarget, type: string, x: number, y: number) =>
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
            button: type === 'pointermove' ? -1 : 0,
            buttons: type === 'pointerup' ? 0 : 1,
            clientX: x,
            clientY: y,
          }),
        );
      fire(element, 'pointerdown', start.x, start.y);
      await frame();
      for (let i = 1; i <= 12; i += 1) {
        const ratio = i / 12;
        const x = start.x + (to.x - start.x) * ratio;
        const y = start.y + (to.y - start.y) * ratio;
        fire(document, 'pointermove', x, y);
        await frame();
      }
      await frame();
      fire(document, 'pointerup', to.x, to.y);
      element.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: to.x, clientY: to.y }),
      );
    },
    { start, to },
  );
}

test.describe('UX12-QEDIT', { tag: '@infra' }, () => {
  test('UX12-QEDIT-AC01 dragging an option by its handle keeps its id and answer', async ({
    page,
    workspaceFactory,
  }) => {
    const s = await seed(workspaceFactory, 'qedit-drag');
    const form = await openEditor(page, s);

    const from = await center(handle(form, 1));
    const to = await center(handle(form, 3));
    const dropY = to.y + 8;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y + 12, { steps: 3 });
    await page.mouse.move(to.x, dropY, { steps: 12 });

    // The dialog's transform would offset a preview that is not portaled out of it.
    const preview = dragPreview(page);
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(TEXTS[0]);
    const box = await preview.boundingBox();
    expect(box).not.toBeNull();
    expect(dropY).toBeGreaterThanOrEqual(box?.y ?? 0);
    expect(dropY).toBeLessThanOrEqual((box?.y ?? 0) + (box?.height ?? 0));
    await page.mouse.up();
    await expect(preview).toBeHidden();

    await expectOptionOrder(form, [TEXTS[1], TEXTS[2], TEXTS[0], TEXTS[3]]);
    await expect(questionFormUi.correct(form, 3)).toBeChecked();
    await expect(questionFormUi.correct(form, 1)).not.toBeChecked();

    await questionFormUi.save(form).click();
    await expect(form).toBeHidden();
    await expectStoredOrder(s, [1, 2, 0, 3]);
    await expectCorrectWhenPicked(page, s, [TEXTS[1], TEXTS[2], TEXTS[0], TEXTS[3]]);
  });

  test('UX12-QEDIT-AC02 touch pointers drag from the handle and a tap moves nothing', async ({
    page,
    workspaceFactory,
  }) => {
    const s = await seed(workspaceFactory, 'qedit-touch');
    const form = await openEditor(page, s);

    await expect(handle(form, 1)).toHaveCSS('touch-action', 'none');

    const tap = await center(handle(form, 2));
    await touchDrag(handle(form, 2), { x: tap.x + 1, y: tap.y + 1 });
    await expectOptionOrder(form, TEXTS);

    const to = await center(handle(form, 3));
    await touchDrag(handle(form, 1), { x: to.x, y: to.y + 8 });
    await expectOptionOrder(form, [TEXTS[1], TEXTS[2], TEXTS[0], TEXTS[3]]);
    await expect(questionFormUi.correct(form, 3)).toBeChecked();
  });

  test('UX12-QEDIT-AC03 the buttons reorder for the keyboard and the handle stays out of it', async ({
    page,
    workspaceFactory,
  }) => {
    const s = await seed(workspaceFactory, 'qedit-keyboard');
    const form = await openEditor(page, s);

    await expect(handle(form, 1)).toHaveAttribute('aria-hidden', 'true');
    await expect(handle(form, 1)).not.toHaveAttribute('tabindex', /.*/);

    await form.getByRole('button', { name: /보기 1 아래로 이동|move option 1 down/i }).focus();
    await page.keyboard.press('Enter');
    await expectOptionOrder(form, [TEXTS[1], TEXTS[0], TEXTS[2], TEXTS[3]]);
    await expect(questionFormUi.correct(form, 2)).toBeChecked();

    await form.getByRole('button', { name: /보기 2 위로 이동|move option 2 up/i }).focus();
    await page.keyboard.press('Enter');
    await expectOptionOrder(form, TEXTS);
    await expect(questionFormUi.correct(form, 1)).toBeChecked();
  });

  test('UX12-QEDIT-AC04 Enter breaks an option line and the break survives saving', async ({
    page,
    workspaceFactory,
  }) => {
    const s = await seed(workspaceFactory, 'qedit-lines');
    const form = await openEditor(page, s);

    const blank = questionFormUi.option(form, 4);
    await blank.fill(' ');
    await blank.press('Enter');
    await expect(form).toBeVisible();
    await expect(blank).toHaveValue(' \n');
    await questionFormUi.save(form).click();
    await expect(blank).toHaveAttribute('aria-invalid', 'true');
    await expect(form).toContainText(/보기 4의 내용을 입력|option 4/i);
    await blank.fill(TEXTS[3]);

    const option = questionFormUi.option(form, 2);
    await option.fill('첫 줄');
    await option.press('End');
    await option.press('Enter');
    await option.pressSequentially('둘째 줄');
    await expect(option).toHaveValue('첫 줄\n둘째 줄');
    await questionFormUi.save(form).click();
    await expect(form).toBeHidden();

    await expect
      .poll(async () => (await getQuestion(s.owner, s.question.id)).revision.options[1]?.text)
      .toBe('첫 줄\n둘째 줄');

    const panel = await openPanel(page, s);
    const label = panelUi.options(panel).nth(1).locator('xpath=..').locator('label');
    await expect(label).toContainText('둘째 줄');
    await expect(label).toHaveCSS('white-space', 'pre-wrap');

    await choosePanelManage(page, panel, 'edit');
    await expect(questionFormUi.option(questionFormUi.form(page), 2)).toHaveValue('첫 줄\n둘째 줄');
  });
});
