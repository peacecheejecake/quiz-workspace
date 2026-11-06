// UX12-CHAPTERADD (docs/screens/ux12-chapter-add.md): 새 챕터 in a question's chapter dropdown and
// Workspace chapters, which need no book. Contract half: tests/integration/questions/
// chapter_management/test_workspace_chapters_contract.py.
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { outlineNodeId, uploadReadyBook } from '../fixtures/documents.ts';
import {
  createQuestion,
  fillMcq,
  getQuestion,
  importPaperDrafts,
  importPath,
  importUi,
  listDrafts,
  numberedMcq,
  questionFormUi,
} from '../fixtures/questions.ts';
import {
  createShareLink,
  openShareWithSecret,
  ShareSession,
  sharedUi,
  startFork,
  waitForFork,
} from '../fixtures/sharing.ts';
import {
  chapterPickerUi,
  expect,
  homePath,
  homeUi,
  JOB_TIMEOUT_MS,
  openSearchOptions,
  overviewUi,
  seedMembership,
  signInAs,
  test,
  type Member,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 4 * JOB_TIMEOUT_MS });

const CH1 = '1장 물의 순환';
const WORKSPACE_GROUP = /^(Workspace 챕터|workspace chapters)$/i;
const PANEL_NAME = /^(챕터 관리|chapter management)$/i;

const ui = {
  add: (page: Page) => page.getByRole('button', { name: /^(새 챕터|new chapter)$/i }),
  name: (page: Page) => page.getByRole('textbox', { name: /^(새 챕터 이름|new chapter name)$/i }),
  submit: (page: Page) => page.getByRole('button', { name: /^(추가|add)$/i }),
  panel: (page: Page) => homeUi.dialog(page, PANEL_NAME),
  group: (panel: Locator, name: RegExp) =>
    panel.locator('section').filter({ has: panel.page().getByRole('heading', { name }) }),
  row: (panel: Locator, title: string) =>
    panel.locator('[data-chapter-row]').filter({ hasText: title }),
  menu: (panel: Locator, title: string) =>
    panel.getByRole('button', { name: new RegExp(`^${title} 챕터 메뉴$`) }),
};

async function openEditor(page: Page, workspaceId: string): Promise<Locator> {
  await page.goto(homePath(workspaceId));
  await homeUi.openMenu(page);
  await homeUi.questionMenuItem(page, 'create').click();
  const form = questionFormUi.form(page);
  await expect(form).toBeVisible();
  return form;
}

async function addChapter(page: Page, title: string): Promise<void> {
  await ui.add(page).click();
  await ui.name(page).fill(title);
  await ui.submit(page).click();
  await expect(page.getByRole('tree')).toHaveCount(0);
}

async function openPanel(page: Page, workspaceId: string): Promise<Locator> {
  await page.goto(`${homePath(workspaceId)}?panel=chapter-management`);
  const panel = ui.panel(page);
  await expect(panel).toBeVisible();
  return panel;
}

async function workspaceChapter(owner: Member, workspaceId: string, title: string) {
  const { chapter } = await owner.api.ok<{ chapter: { id: string } }>(
    'POST',
    `/workspaces/${workspaceId}/chapters`,
    { title },
    [201],
  );
  return chapter.id;
}

test(
  'UX12-CHAPTERADD-AC01 a chapter made in the dropdown of a workspace without a book is chosen at once and saved',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-chadd-01');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    const form = await openEditor(page, ws.id);
    const stem = `교재 없는 문제 [${ws.id.slice(0, 8)}]`;
    await fillMcq(page, stem, ['응결', '증발', '강수', '침전'], 1);

    const trigger = questionFormUi.chapter(form);
    await trigger.click();
    await addChapter(page, '시험 범위 1');
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText('시험 범위 1');

    await questionFormUi.save(form).click();
    await expect(form).toBeHidden();
    await page.goto(homePath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(page.getByText('시험 범위 1').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /시험 범위 1 정리 노트/ })).toHaveCount(0);
  },
);

test(
  'UX12-CHAPTERADD-AC02 the dropdown adds to the book of the chosen chapter, otherwise to the Workspace chapters',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-chadd-02');
    const ws = await workspaceFactory.create(owner);
    const bookId = await uploadReadyBook(owner, ws.id, 'book-ko');
    await signInAs(page, owner.user);

    const form = await openEditor(page, ws.id);
    const trigger = questionFormUi.chapter(form);
    await trigger.click();
    await addChapter(page, '문제 쪽 장');
    await expect(trigger).toContainText('문제 쪽 장');

    await trigger.click();
    await chapterPickerUi.row(page, CH1).click();
    await trigger.click();
    await addChapter(page, '교재 쪽 장');

    const panel = await openPanel(page, ws.id);
    await expect(ui.row(ui.group(panel, WORKSPACE_GROUP), '문제 쪽 장')).toBeVisible();
    const book = panel.locator('section').filter({ hasText: CH1 });
    await expect(book.locator('[data-chapter-row]').last()).toContainText('교재 쪽 장');
    await expect(outlineNodeId(owner, bookId, '교재 쪽 장')).resolves.toBeTruthy();
  },
);

test(
  'UX12-CHAPTERADD-AC03 새 챕터 works without a mouse and Escape leaves the name box only',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-chadd-03');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    const form = await openEditor(page, ws.id);
    const trigger = questionFormUi.chapter(form);

    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(chapterPickerUi.filter(page)).toBeFocused();
    await page.keyboard.type('중간고사');
    await expect(
      page.getByRole('status').filter({ hasText: /찾는 챕터가 없습니다/ }),
    ).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(ui.add(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(ui.name(page)).toBeFocused();
    await expect(ui.name(page)).toHaveValue('중간고사');

    await page.keyboard.press('Escape');
    await expect(ui.name(page)).toHaveCount(0);
    await expect(ui.add(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await ui.name(page).fill('');
    await expect(ui.submit(page)).toBeDisabled();
    await page.keyboard.type('기말고사');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('tree')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText('기말고사');
  },
);

test(
  'UX12-CHAPTERADD-AC04 at 375px 새 챕터 is a 44px target in the sheet and the modal editor stays open',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    const owner = await workspaceFactory.member('ux12-chadd-04');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    const form = await openEditor(page, ws.id);
    const trigger = questionFormUi.chapter(form);

    await trigger.click();
    const add = ui.add(page);
    await expect(add).toBeVisible();
    const box = await add.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await addChapter(page, '모바일 장');

    await expect(form).toBeVisible();
    await expect(trigger).toContainText('모바일 장');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  },
);

test(
  'UX12-CHAPTERADD-AC05 viewers cannot add a chapter and the home filter never offers it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-chadd-05');
    const ws = await workspaceFactory.create(owner);
    const chapter = await workspaceChapter(owner, ws.id, '범위');
    await createQuestion(owner, ws.id, {
      ...numberedMcq('ux12-chadd-05', 1),
      chapter_id: chapter,
    });
    const viewer = await workspaceFactory.member('ux12-chadd-05v');
    seedMembership(ws.id, viewer.user.id, 'viewer');

    const refused = await viewer.api.request('POST', `/workspaces/${ws.id}/chapters`, {
      title: 'x',
    });
    expect(refused.status).toBe(403);

    for (const member of [viewer, owner]) {
      await signInAs(page, member.user);
      await page.goto(homePath(ws.id));
      await expect(overviewUi.dots(page)).toHaveCount(1);
      const popover = await openSearchOptions(page, 'questions');
      await popover.getByRole('combobox', { name: /^(챕터|chapter)$/i }).click();
      await expect(chapterPickerUi.row(page, '범위')).toBeVisible();
      await expect(ui.add(page)).toHaveCount(0);
      await page.context().clearCookies();
    }
  },
);

test(
  'UX12-CHAPTERADD-AC06 챕터 관리 without a book manages the Workspace chapters',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-chadd-06');
    const ws = await workspaceFactory.create(owner);
    const chapter = await workspaceChapter(owner, ws.id, '가');
    const question = await createQuestion(owner, ws.id, {
      ...numberedMcq('ux12-chadd-06', 1),
      chapter_id: chapter,
    });
    await signInAs(page, owner.user);
    const panel = await openPanel(page, ws.id);
    await expect(panel.getByRole('heading', { name: WORKSPACE_GROUP })).toBeVisible();
    await expect(panel.getByText(/교재 PDF를 먼저/)).toHaveCount(0);

    await panel.getByRole('button', { name: /^(챕터 추가|add chapter)$/i }).click();
    await panel.getByRole('textbox', { name: /챕터 이름/ }).fill('나');
    await panel.getByRole('button', { name: /^(추가|add)$/i }).click();
    await expect(ui.row(panel, '나')).toBeVisible();

    await ui.menu(panel, '나').click();
    await page.getByRole('menuitem', { name: /이름 바꾸기|rename/i }).click();
    await panel.getByRole('textbox', { name: /챕터 이름/ }).fill('다');
    await panel.getByRole('button', { name: /^(저장|save)$/i }).click();
    await expect(ui.row(panel, '다')).toBeVisible();

    await ui.menu(panel, '다').click();
    await page.getByRole('menuitem', { name: /들여쓰기|indent/i }).click();
    await expect(page.getByText(/옮겼습니다/)).toBeVisible();
    await ui.menu(panel, '다').click();
    await page.getByRole('menuitem', { name: /내어쓰기|outdent/i }).click();
    await expect(ui.row(panel, '다')).toBeVisible();

    await ui.menu(panel, '가').click();
    await page.getByRole('menuitem', { name: /^(삭제|delete)$/i }).click();
    const remove = panel.getByRole('button', { name: /^(삭제|delete)$/i });
    await expect(remove).toBeDisabled();
    await panel.getByRole('combobox', { name: /문제를 옮길 챕터/ }).click();
    await chapterPickerUi.row(page, '다').click();
    await remove.click();
    await expect(ui.row(panel, '가')).toHaveCount(0);

    await page.reload();
    await expect(ui.row(ui.panel(page), '다')).toBeVisible();
    const after = await getQuestion(owner, question.id);
    expect(after.chapter_id).not.toBeNull();
    expect(after.chapter_id).not.toBe(chapter);
    expect(after.revision.id).toBe(question.revision.id);
  },
);

test(
  'UX12-CHAPTERADD-AC07 a share shows Workspace chapters and a fork carries them on its own',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-chadd-07');
    const ws = await workspaceFactory.create(owner);
    const chapter = await workspaceChapter(owner, ws.id, '공유 범위');
    const input = numberedMcq(`ux12-chadd-07-${randomUUID().slice(0, 6)}`, 1);
    await createQuestion(owner, ws.id, { ...input, chapter_id: chapter });
    const link = await createShareLink(owner, ws.id, { allow_fork: true });

    await openShareWithSecret(page, link.id, link.secret);
    await expect(sharedUi.question(page, input.stem)).toContainText('공유 범위');
    await expect(page.getByRole('button', { name: /^(새 챕터|챕터 추가)$/ })).toHaveCount(0);

    const recipient = await workspaceFactory.member('ux12-chadd-07r');
    const session = await ShareSession.open(link.id, link.secret);
    const fork = await startFork(recipient, session, `ux12-chadd-${randomUUID().slice(0, 6)}`);
    const done = await waitForFork(recipient, fork.id, 'COMPLETED');
    const target = done.target_workspace_id as string;

    await owner.api.ok('PATCH', `/chapters/${chapter}`, { title: '원본만' });
    await page.context().clearCookies();
    await signInAs(page, recipient.user);
    const panel = await openPanel(page, target);
    const row = ui.row(panel, '공유 범위');
    await expect(row).toBeVisible();
    await expect(row.getByLabel(/^1문제$/)).toBeVisible();
  },
);

test(
  'UX12-CHAPTERADD-AC08 an import draft of a question-paper-only workspace takes a new chapter and registers under it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-chadd-08');
    const ws = await workspaceFactory.create(owner);
    const { run } = await importPaperDrafts(owner, ws.id);
    await signInAs(page, owner.user);
    await page.goto(importPath(ws.id));

    const pickers = importUi.drafts(page).getByRole('combobox', { name: /번 문제 챕터/ });
    await pickers.first().click();
    await addChapter(page, '가져온 범위');
    await expect(pickers.first()).toContainText('가져온 범위');
    await expect
      .poll(async () => {
        const drafts = await listDrafts(owner, run.id);
        return drafts.filter((d) => d.chapter_choice === 'manual').length;
      })
      .toBe(1);

    await pickers.nth(1).click();
    await expect(chapterPickerUi.row(page, '가져온 범위')).toBeVisible();
    await page.keyboard.press('Escape');
  },
);
