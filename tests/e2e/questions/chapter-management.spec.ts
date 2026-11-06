// CHMAN-01 — 챕터 관리 modal panel (`/workspaces/:id?panel=chapter-management`),
// docs/screens/chapter-management.md; rules docs/questions.md §14.5. Contract half (C01–C07):
// tests/integration/questions/chapter_management/.
//
// Each test uploads the synthetic book-ko.pdf (chapters "1장 물의 순환" / "2장 정수 처리", each with
// two sections) into its own workspace. Pointer drags use the real mouse on the row's grip.
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { generateNote, noteQuestion } from '../fixtures/chapter-notes.ts';
import { chapterChangeCount, revisionCount } from '../fixtures/chapter-redistribution.ts';
import {
  answerCorrectly,
  chapterPickerUi,
  createQuestion,
  expect,
  getQuestion,
  homePath,
  homeUi,
  JOB_TIMEOUT_MS,
  openSearchOptions,
  outlineNodeId,
  QUESTION_MENU_REASONS,
  seedMembership,
  signInAs,
  test,
  uploadReadyBook,
  type Member,
} from '../fixtures/test.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 6 * JOB_TIMEOUT_MS });

const CH1 = '1장 물의 순환';
const CH2 = '2장 정수 처리';
const S11 = '1.1 증발과 응결';
const PANEL_NAME = /^(챕터 관리|chapter management)$/i;

interface Space {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly ch1: string;
  readonly ch2: string;
  readonly label: string;
}

async function bookSpace(factory: WorkspaceFactory, label: string): Promise<Space> {
  const owner = await factory.member(label);
  const ws = await factory.create(owner);
  const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
  return {
    owner,
    workspaceId: ws.id,
    documentId,
    ch1: await outlineNodeId(owner, documentId, CH1),
    ch2: await outlineNodeId(owner, documentId, CH2),
    label: `${label}-${randomUUID().slice(0, 4)}`,
  };
}

const ui = {
  panel: (page: Page) => homeUi.dialog(page, PANEL_NAME),
  tree: (panel: Locator) => panel.getByRole('list', { name: /챕터$/ }).first(),
  row: (panel: Locator, id: string) => panel.locator(`[data-chapter-row="${id}"]`),
  rowByTitle: (panel: Locator, title: string) =>
    panel.locator('[data-chapter-row]').filter({ hasText: title }),
  menu: (panel: Locator, title: string) =>
    panel.getByRole('button', { name: new RegExp(`^${title} 챕터 메뉴$`) }),
  grip: (row: Locator) => row.locator('[data-chapter-grip]'),
  questionRow: (panel: Locator, id: string) => panel.locator(`[data-question-row="${id}"]`),
  titles: async (panel: Locator) =>
    (await panel.locator('[data-chapter-row]').allInnerTexts()).map((t) => t.split('\n')[0] ?? ''),
};

async function openPanel(page: Page, space: Space): Promise<Locator> {
  await page.goto(`${homePath(space.workspaceId)}?panel=chapter-management`);
  const panel = ui.panel(page);
  await expect(panel).toBeVisible();
  await expect(ui.rowByTitle(panel, CH1)).toBeVisible();
  return panel;
}

async function chooseRowItem(page: Page, panel: Locator, title: string, item: RegExp) {
  await ui.menu(panel, title).click();
  await page.getByRole('menuitem', { name: item }).click();
}

async function addChapter(page: Page, panel: Locator, title: string) {
  await panel
    .getByRole('button', { name: /^(챕터 추가|add chapter)$/i })
    .first()
    .click();
  await panel.getByRole('textbox', { name: /챕터 이름|chapter name/i }).fill(title);
  await panel.getByRole('button', { name: /^(추가|add)$/i }).click();
  await expect(ui.rowByTitle(panel, title)).toBeVisible();
}

/** Drags with the real mouse: down on the grip, past the 4px threshold, up on the target. */
async function drag(page: Page, from: Locator, to: Locator) {
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  if (!start || !end) throw new Error('drag: an element is not on screen');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2 + 10, { steps: 3 });
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
}

test(
  'CHMAN-01-AC01 an owner opens the tree from the menu; viewers and archived workspaces cannot',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookSpace(workspaceFactory, 'chman01-ac01');
    await createQuestion(s.owner, s.workspaceId, noteQuestion(s.label, 1, s.ch1, 'ok'));
    await signInAs(page, s.owner.user);
    await page.goto(homePath(s.workspaceId));
    await homeUi.openMenu(page);
    await homeUi.questionMenuItem(page, 'chapters').click();
    const panel = ui.panel(page);
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(/panel=chapter-management/);
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    await expect(ui.row(panel, s.ch1)).toContainText(CH1);
    await expect(ui.row(panel, s.ch1).getByLabel('1문제')).toBeVisible();
    await expect(ui.row(panel, s.ch2).getByLabel('0문제')).toBeVisible();

    const viewer = await workspaceFactory.member('chman01-ac01-viewer');
    seedMembership(s.workspaceId, viewer.user.id, 'viewer');
    const viewerContext = await page.context().browser()?.newContext();
    if (!viewerContext) throw new Error('no browser');
    const viewerPage = await viewerContext.newPage();
    await signInAs(viewerPage, viewer.user);
    await viewerPage.goto(`${homePath(s.workspaceId)}?panel=chapter-management`);
    await expect(ui.panel(viewerPage)).toHaveCount(0);
    await expect(viewerPage).not.toHaveURL(/panel=chapter-management/);
    await homeUi.openMenu(viewerPage);
    const item = homeUi.questionMenuItem(viewerPage, 'chapters');
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await expect(viewerPage.getByText(QUESTION_MENU_REASONS.viewer)).toBeVisible();
    await viewerContext.close();
  },
);

test(
  'CHMAN-01-AC02 adding and renaming chapters applies at once, without a draft',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookSpace(workspaceFactory, 'chman01-ac02');
    await signInAs(page, s.owner.user);
    const panel = await openPanel(page, s);

    await addChapter(page, panel, `${s.label} 부록`);
    await chooseRowItem(page, panel, CH1, /^(하위 챕터 추가|add sub-chapter)$/i);
    await panel.getByRole('textbox', { name: /챕터 이름|chapter name/i }).fill(`${s.label} 하위`);
    await panel.getByRole('button', { name: /^(추가|add)$/i }).click();
    await expect(ui.rowByTitle(panel, `${s.label} 하위`)).toBeVisible();

    await chooseRowItem(page, panel, `${s.label} 부록`, /^(이름 바꾸기|rename)$/i);
    await panel.getByRole('textbox', { name: /챕터 이름|chapter name/i }).fill(`${s.label} 고침`);
    await panel.getByRole('button', { name: /^(저장|save)$/i }).click();
    await expect(ui.rowByTitle(panel, `${s.label} 고침`)).toBeVisible();

    const outline = await s.owner.api.request(
      'GET',
      `/documents/${s.documentId}/outline?revision=latest`,
    );
    const body = outline.body as { revision: { is_active: boolean } };
    expect(body.revision.is_active, 'no draft revision').toBe(true);

    await page.reload();
    await expect(ui.rowByTitle(ui.panel(page), `${s.label} 고침`)).toBeVisible();
  },
);

test(
  'CHMAN-01-AC03 deleting asks where the questions go and warns about the note',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookSpace(workspaceFactory, 'chman01-ac03');
    const question = await createQuestion(
      s.owner,
      s.workspaceId,
      noteQuestion(s.label, 1, s.ch2, 'ok', { question_number: 1 }),
    );
    await answerCorrectly(s.owner, question);
    await generateNote(s.owner, s.ch2);
    const revisions = revisionCount(question.id);
    await signInAs(page, s.owner.user);
    const panel = await openPanel(page, s);

    await chooseRowItem(page, panel, CH2, /^(삭제|delete)$/i);
    const confirm = panel.getByRole('region', { name: /삭제할까요|delete/i });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(/정리 노트는 더 이상 보이지 않습니다/)).toBeVisible();
    const remove = confirm.getByRole('button', { name: /^(삭제|delete)$/i });
    await expect(remove).toBeDisabled();
    await expect(remove).toHaveAccessibleDescription(/옮길 챕터를 고르세요/);

    const picker = confirm.getByRole('combobox', { name: /문제를 옮길 챕터/ });
    await picker.click();
    await chapterPickerUi.row(page, CH1).click();
    await expect(remove).toBeEnabled();
    await remove.click();

    await expect(ui.row(panel, s.ch2)).toHaveCount(0);
    await expect(ui.row(panel, s.ch1).getByLabel('1문제')).toBeVisible();
    const moved = await getQuestion(s.owner, question.id);
    expect(moved.chapter_id).toBe(s.ch1);
    expect(revisionCount(question.id)).toBe(revisions);
    expect(chapterChangeCount(s.workspaceId)).toBe(1);
    // Its two sections stay, one level up.
    expect((await ui.titles(panel)).length).toBeGreaterThanOrEqual(4);
  },
);

test(
  'CHMAN-01-AC04 rows move by drag and by the row menu, and the moves survive a reload',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookSpace(workspaceFactory, 'chman01-ac04');
    await signInAs(page, s.owner.user);
    const panel = await openPanel(page, s);

    await drag(page, ui.grip(ui.row(panel, s.ch2)), ui.row(panel, s.ch1));
    await expect(ui.row(panel, s.ch2)).toHaveCSS('padding-inline-start', /^[1-9]/);

    await ui.menu(panel, CH2).click();
    await expect(page.getByRole('menuitem', { name: /^(위로|move up)$/i })).toBeVisible();
    await page.keyboard.press('Escape');

    await chooseRowItem(page, panel, CH2, /^(내어쓰기|outdent)$/i);
    await expect(ui.row(panel, s.ch2)).toHaveCSS('padding-inline-start', '0px');

    await ui.menu(panel, CH1).focus();
    await page.keyboard.press('Enter');
    const up = page.getByRole('menuitem', { name: /^(위로|move up)$/i });
    await expect(up).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');

    await chooseRowItem(page, panel, CH2, /^(위로|move up)$/i);
    await expect.poll(async () => (await ui.titles(panel))[0]).toBe(CH2);
    await page.reload();
    const fresh = ui.panel(page);
    await expect.poll(async () => (await ui.titles(fresh))[0]).toBe(CH2);
  },
);

test(
  'CHMAN-01-AC05 a tree changed elsewhere refuses the move and is read again',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookSpace(workspaceFactory, 'chman01-ac05');
    await signInAs(page, s.owner.user);
    const panel = await openPanel(page, s);

    const elsewhere = await s.owner.api.request('POST', `/workspaces/${s.workspaceId}/chapters`, {
      document_id: s.documentId,
      parent_id: null,
      title: `${s.label} 다른 탭`,
    });
    expect(elsewhere.status).toBe(201);

    await chooseRowItem(page, panel, CH2, /^(위로|move up)$/i);
    await expect(panel.getByRole('alert')).toContainText(
      /그 사이 챕터가 바뀌어 저장하지 않았습니다/,
    );
    await expect(ui.rowByTitle(panel, `${s.label} 다른 탭`)).toBeVisible();
    expect((await ui.titles(panel)).indexOf(CH1)).toBe(0);
  },
);

test(
  'CHMAN-01-AC06 a question dropped on a chapter moves there, also through its picker',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookSpace(workspaceFactory, 'chman01-ac06');
    const first = await createQuestion(
      s.owner,
      s.workspaceId,
      noteQuestion(s.label, 1, s.ch1, 'ok', { question_number: 1 }),
    );
    const second = await createQuestion(
      s.owner,
      s.workspaceId,
      noteQuestion(s.label, 2, s.ch1, 'ok', { question_number: 2 }),
    );
    await answerCorrectly(s.owner, first);
    await signInAs(page, s.owner.user);
    const panel = await openPanel(page, s);

    await drag(
      page,
      ui.questionRow(panel, first.id).locator('[data-question-grip]'),
      ui.row(panel, s.ch2),
    );
    await expect(ui.row(panel, s.ch2).getByLabel('1문제')).toBeVisible();
    await expect(ui.row(panel, s.ch1).getByLabel('1문제')).toBeVisible();
    expect((await getQuestion(s.owner, first.id)).chapter_id).toBe(s.ch2);

    await ui
      .questionRow(panel, second.id)
      .getByRole('combobox', { name: /챕터로 옮기기/ })
      .click();
    await chapterPickerUi.row(page, CH2).click();
    await expect(ui.row(panel, s.ch2).getByLabel('2문제')).toBeVisible();
    expect((await getQuestion(s.owner, second.id)).chapter_id).toBe(s.ch2);
  },
);

test(
  'CHMAN-01-AC07 the home filter nests a sub-chapter under its parent',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookSpace(workspaceFactory, 'chman01-ac07');
    const section = await outlineNodeId(s.owner, s.documentId, S11);
    await createQuestion(s.owner, s.workspaceId, noteQuestion(s.label, 1, section, 'ok'));
    await signInAs(page, s.owner.user);
    await page.goto(homePath(s.workspaceId));
    const options = await openSearchOptions(page, 'questions');
    await options.getByRole('combobox', { name: /^(챕터|chapter)$/i }).click();
    await expect(chapterPickerUi.row(page, CH1)).toHaveAttribute('aria-expanded', 'true');
    await expect(chapterPickerUi.row(page, S11)).toHaveAttribute('aria-level', '2');
  },
);

test.describe('touch', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test(
    'CHMAN-01-AC08 at 375px the row menu moves chapters without a drag or sideways scroll',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const s = await bookSpace(workspaceFactory, 'chman01-ac08');
      await signInAs(page, s.owner.user);
      const panel = await openPanel(page, s);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);

      const menu = ui.menu(panel, CH2);
      const box = await menu.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);

      await menu.tap();
      await page.getByRole('menuitem', { name: /^(들여쓰기|indent)$/i }).tap();
      await expect(ui.row(panel, s.ch2)).toHaveCSS('padding-inline-start', /^[1-9]/);
    },
  );
});
