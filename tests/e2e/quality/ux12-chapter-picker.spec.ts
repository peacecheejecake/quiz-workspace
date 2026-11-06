// UX12-PICKER (docs/screens/ux12-chapter-picker.md): the chapter tree popover that replaces the six
// single-choice dropdowns. book-ko.pdf is the real two-level outline: 1장 > 1.1, 1.2; 2장 > 2.1, 2.2.

import type { Locator, Page } from '@playwright/test';
import { askUi, openAskPanel, seedAskBook } from '../fixtures/ask.ts';
import { redistUi } from '../fixtures/chapter-redistribution.ts';
import { seedBookChapters, seedImportDraftCopies } from '../fixtures/db.ts';
import { outlineNodeId, uploadReadyBook } from '../fixtures/documents.ts';
import {
  bookChapterOptions,
  createNumberedQuestions,
  fillMcq,
  importPaperDrafts,
  importPath,
  importUi,
  listDrafts,
  listQuestions,
  numberedMcq,
  questionFormUi,
} from '../fixtures/questions.ts';
import {
  chapterPickerUi,
  chooseFilter,
  closeSearchOptions,
  expect,
  homePath,
  homeUi,
  openSearchOptions,
  overviewUi,
  searchUi,
  signInAs,
  test,
  type E2EFixtures,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

type Factory = E2EFixtures['workspaceFactory'];

const CH1 = '1장 물의 순환';
const CH2 = '2장 정수 처리';
const S11 = '1.1 증발과 응결';
const S22 = '2.2 여과와 소독';
const NONE = '챕터 없음';
const CHAPTER = /^(챕터|chapter)$/i;
const NO_MATCH = /찾는 챕터가 없습니다|no matching chapter/i;
const CLOSE = /닫기$|^close/i;

const pickerPopover = (page: Page, name: RegExp) => page.getByRole('dialog', { name });

async function ownerWithBook(factory: Factory, label: string) {
  const owner = await factory.member(label);
  const ws = await factory.create(owner);
  const bookId = await uploadReadyBook(owner, ws.id, 'book-ko');
  return { owner, ws, bookId };
}

async function openEditor(page: Page, workspaceId: string): Promise<Locator> {
  await page.goto(homePath(workspaceId));
  await homeUi.openMenu(page);
  await homeUi.questionMenuItem(page, 'create').click();
  const form = questionFormUi.form(page);
  await expect(form).toBeVisible();
  return form;
}

const box = async (target: Locator) => {
  const found = await target.boundingBox();
  if (!found) throw new Error('not visible');
  return found;
};

test(
  'UX12-PICKER-AC01 the picker is a tree popover: rows collapse and expand, a choice closes it and reopens on its path',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, ws, bookId } = await ownerWithBook(workspaceFactory, 'ux12-picker-01');
    const s11 = await outlineNodeId(owner, bookId, S11);
    await signInAs(page, owner.user);
    const form = await openEditor(page, ws.id);
    const text = `물의 상태 변화는? [${ws.id.slice(0, 8)}]`;
    await fillMcq(page, text, ['응결', '증발', '강수', '침전'], 1);

    const trigger = questionFormUi.chapter(form);
    await expect(page.getByRole('tree')).toHaveCount(0);
    await trigger.click();
    await expect(pickerPopover(page, CHAPTER)).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(chapterPickerUi.rows(page)).toHaveCount(3);
    await expect(chapterPickerUi.row(page, NONE)).toBeVisible();
    await expect(chapterPickerUi.row(page, CH1)).toHaveAttribute('aria-expanded', 'false');
    await expect(chapterPickerUi.row(page, S11)).toHaveCount(0);

    await chapterPickerUi.expand(page, CH1).click();
    await expect(chapterPickerUi.row(page, CH1)).toHaveAttribute('aria-expanded', 'true');
    await expect(chapterPickerUi.row(page, S11)).toHaveAttribute('aria-level', '2');
    await chapterPickerUi.collapse(page, CH1).click();
    await expect(chapterPickerUi.row(page, S11)).toHaveCount(0);
    await expect(pickerPopover(page, CHAPTER)).toBeVisible();

    await chapterPickerUi.expand(page, CH1).click();
    await chapterPickerUi.row(page, S11).click();
    await expect(page.getByRole('tree')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText(S11);

    await trigger.click();
    await expect(chapterPickerUi.row(page, CH1)).toHaveAttribute('aria-expanded', 'true');
    await expect(chapterPickerUi.row(page, S11)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');

    await questionFormUi.save(form).click();
    await expect(form).toBeHidden();
    const [saved] = await listQuestions(owner, ws.id);
    expect(saved?.chapter_id).toBe(s11);
  },
);

test(
  'UX12-PICKER-AC02 typing filters to the matching rows and their parents, and Enter picks the first match',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, ws } = await ownerWithBook(workspaceFactory, 'ux12-picker-02');
    await signInAs(page, owner.user);
    const form = await openEditor(page, ws.id);
    const trigger = questionFormUi.chapter(form);
    await trigger.click();
    const filter = chapterPickerUi.filter(page);
    await expect(filter).toBeFocused();
    await chapterPickerUi.expand(page, CH1).click();
    await expect(chapterPickerUi.rows(page)).toHaveCount(5);

    await filter.fill('여과');
    await expect(chapterPickerUi.rows(page)).toHaveCount(2);
    await expect(chapterPickerUi.row(page, CH2)).toBeVisible();
    await expect(chapterPickerUi.row(page, S22)).toHaveAttribute('aria-level', '2');
    await expect(chapterPickerUi.collapse(page, CH2)).toHaveCount(0);

    await filter.fill('없는 제목');
    await expect(page.getByRole('tree')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: NO_MATCH })).toBeVisible();

    await filter.fill('');
    await expect(chapterPickerUi.rows(page)).toHaveCount(5);

    await filter.fill('여과');
    await filter.press('Enter');
    await expect(page.getByRole('tree')).toHaveCount(0);
    await expect(trigger).toContainText(CH2);
    await expect(trigger).toBeFocused();
  },
);

test(
  'UX12-PICKER-AC03 the whole tree works from the keyboard with one tab stop',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, ws } = await ownerWithBook(workspaceFactory, 'ux12-picker-03');
    await signInAs(page, owner.user);
    const form = await openEditor(page, ws.id);
    const trigger = questionFormUi.chapter(form);
    await trigger.focus();
    await page.keyboard.press('Enter');
    const filter = chapterPickerUi.filter(page);
    await expect(filter).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(chapterPickerUi.row(page, NONE)).toBeFocused();
    await expect(page.getByRole('tree').locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press('End');
    await expect(chapterPickerUi.row(page, CH2)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(chapterPickerUi.row(page, NONE)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(chapterPickerUi.row(page, CH1)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(chapterPickerUi.row(page, CH1)).toHaveAttribute('aria-expanded', 'true');
    await expect(chapterPickerUi.row(page, CH1)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(chapterPickerUi.row(page, S11)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(chapterPickerUi.row(page, CH1)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(chapterPickerUi.row(page, CH1)).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowUp');
    await expect(filter).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('tree')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText(NONE);

    await page.keyboard.press('ArrowDown');
    await expect(filter).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tree')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText(CH1);
  },
);

test(
  'UX12-PICKER-AC04 inside the modal 챕터 재분배 dialog the picker stacks above it and Escape closes only the picker',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, ws, bookId } = await ownerWithBook(workspaceFactory, 'ux12-picker-04');
    seedBookChapters(bookId, 40);
    await createNumberedQuestions(owner, ws.id, 'ux12-picker-04', 1);
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    await homeUi.openMenu(page);
    await redistUi.menuItem(page).click();
    const dialog = redistUi.dialog(page);
    await expect(dialog).toBeVisible();

    const trigger = redistUi.target(dialog);
    await trigger.click();
    const row = chapterPickerUi.row(page, CH1);
    await expect(row).toBeVisible();
    // The popover, not the panel under it, is what the pointer hits.
    const hit = await row.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return top !== null && el.contains(top);
    });
    expect(hit, 'the row is on top at its own position').toBe(true);

    // A wheel over the list scrolls it, not the panel.
    const tree = page.getByRole('tree');
    const panelScroll = () =>
      dialog.evaluate((el) => [...el.querySelectorAll('*')].map((n) => n.scrollTop).join());
    const before = await panelScroll();
    const area = await box(tree);
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
    await page.mouse.wheel(0, 240);
    await expect.poll(() => tree.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await panelScroll()).toBe(before);

    await page.keyboard.press('Escape');
    await expect(tree).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(trigger).toBeFocused();

    await chooseFilter(page, trigger, new RegExp(`^${S22}`));
    await expect(trigger).toContainText(S22);
    await expect(dialog).toBeVisible();
    await expect(redistUi.pickChapterReason(dialog)).toHaveCount(0);
  },
);

test.describe('sheet', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test(
    'UX12-PICKER-AC05 below 768px the picker is a full-width bottom sheet that does not raise the keyboard',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const { owner, ws } = await ownerWithBook(workspaceFactory, 'ux12-picker-05');
      await signInAs(page, owner.user);
      const form = await openEditor(page, ws.id);
      const trigger = questionFormUi.chapter(form);
      await trigger.click();
      const sheet = pickerPopover(page, CHAPTER);
      await expect(sheet).toBeVisible();

      await expect
        .poll(async () => {
          const found = await box(sheet);
          return [found.x, found.width, Math.round(found.y + found.height)];
        })
        .toEqual([0, 375, 667]);
      expect((await box(sheet)).height).toBeLessThanOrEqual(667 * 0.7 + 1);
      await expect(chapterPickerUi.filter(page)).not.toBeFocused();
      await expect(chapterPickerUi.row(page, NONE)).toBeFocused();

      await sheet.getByRole('button', { name: CLOSE }).click();
      await expect(sheet).toHaveCount(0);
      await expect(trigger).toBeFocused();

      await page.setViewportSize({ width: 1280, height: 800 });
      await trigger.click();
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole('button', { name: CLOSE })).toHaveCount(0);
      await expect.poll(async () => (await box(sheet)).width).toBeLessThan(1280);
      await expect(chapterPickerUi.filter(page)).toBeFocused();
    },
  );
});

const SCALE_COPIES = 124; // 8 × 125 = 1000 drafts
const SCALE_CHAPTERS = 300;
const SCALE_MAX_ELEMENTS = 8000;
const REVIEW_PAGE_SIZE = 100;

test(
  'UX12-PICKER-AC06 a review of 1000 drafts over 300 chapters holds no tree until a picker opens',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(240_000);
    const { owner, ws, bookId } = await ownerWithBook(workspaceFactory, 'ux12-picker-06');
    seedBookChapters(bookId, SCALE_CHAPTERS);
    const { run } = await importPaperDrafts(owner, ws.id);
    expect(seedImportDraftCopies(run.id, SCALE_COPIES)).toBe(1000);

    await signInAs(page, owner.user);
    await page.goto(importPath(ws.id));
    await expect(importUi.draftsHeading(page)).toContainText('1000개', { timeout: 30_000 });
    const pickers = importUi.drafts(page).getByRole('combobox', { name: /번 문제 챕터/ });
    await expect(pickers).toHaveCount(REVIEW_PAGE_SIZE);
    await expect(page.getByRole('treeitem')).toHaveCount(0);
    expect(await page.evaluate(() => document.getElementsByTagName('*').length)).toBeLessThan(
      SCALE_MAX_ELEMENTS,
    );

    const first = pickers.first();
    await first.click();
    const options = await bookChapterOptions(owner, run.id);
    // The top level of the outline: everything but the 4 sub-chapters of book-ko.
    await expect(chapterPickerUi.rows(page)).toHaveCount(options - 4);
    const last = `제${100 + SCALE_CHAPTERS}장 합성 단원 ${SCALE_CHAPTERS}`;
    await chapterPickerUi.filter(page).fill(last);
    await chapterPickerUi.row(page, last).click();
    await expect(page.getByRole('treeitem')).toHaveCount(0);
    await expect(first).toContainText(last);
    await expect
      .poll(async () => {
        const drafts = await listDrafts(owner, run.id);
        return drafts.filter((d) => d.chapter_choice === 'manual').length;
      })
      .toBe(1);
  },
);

test(
  'UX12-PICKER-AC07 본문 검색 and AI 질문 pick sub-chapters and search only their subtree',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-picker-07');
    const ws = await workspaceFactory.create(owner);
    const book = await seedAskBook(owner, ws.id);
    const s22 = await outlineNodeId(owner, book.documentId, S22);
    await signInAs(page, owner.user);

    await page.goto(`${homePath(ws.id)}/search`);
    await openSearchOptions(page);
    await chooseFilter(page, searchUi.documentFilter(page), new RegExp(book.title));
    const section = searchUi.chapterFilter(page);
    await chooseFilter(page, section, new RegExp(`^${S22}`));
    await expect(section).toContainText(S22);
    await closeSearchOptions(page);
    await searchUi.box(page).fill('소독');
    await searchUi.box(page).press('Enter');
    await expect(page).toHaveURL((url) => url.searchParams.get('section') === s22);
    await expect(searchUi.resultItems(page).first()).toBeVisible();

    // A sub-chapter of the address is known, not cleared as a stale filter.
    await page.reload();
    await openSearchOptions(page);
    await expect(searchUi.chapterFilter(page)).toContainText(S22);
    await closeSearchOptions(page);

    await page.goto(homePath(ws.id));
    const panel = await openAskPanel(page);
    await askUi.scopeButton(panel).click();
    const popover = askUi.scopePopover(page);
    await chooseFilter(
      page,
      popover.getByRole('combobox', { name: /^(문서|document)$/i }),
      new RegExp(book.title),
    );
    const scopeChapter = popover.getByRole('combobox', { name: /^(장|section)$/i });
    await chooseFilter(page, scopeChapter, new RegExp(`^${S22}`));
    await expect(popover).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(askUi.scopeText(panel)).toContainText(S22);
  },
);

test(
  'UX12-PICKER-AC08 the home 필터 popover uses the picker and stays open after a choice',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, ws, bookId } = await ownerWithBook(workspaceFactory, 'ux12-picker-08');
    const ch1 = await outlineNodeId(owner, bookId, CH1);
    await createNumberedQuestions(owner, ws.id, 'ux12-picker-08', 3, (n) => ({
      ...numberedMcq('ux12-picker-08', n),
      chapter_id: n === 1 ? ch1 : null,
    }));
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(3);

    const popover = await openSearchOptions(page, 'questions');
    const chapter = popover.getByRole('combobox', { name: CHAPTER });
    await chapter.click();
    await expect(chapterPickerUi.rows(page)).toHaveCount(3); // 전체 챕터, 1장, 챕터 없음
    await chapterPickerUi.row(page, CH1).click();
    await expect(page.getByRole('tree')).toHaveCount(0);
    await expect(popover).toBeVisible();
    await expect(overviewUi.dots(page)).toHaveCount(1);

    await chooseFilter(page, chapter, /전체 챕터|all chapters/i);
    await expect(overviewUi.dots(page)).toHaveCount(3);
    await expect(popover).toBeVisible();
  },
);

test(
  'UX12-PICKER-AC09 with two books the tree groups chapters under unselectable document rows',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, ws } = await ownerWithBook(workspaceFactory, 'ux12-picker-09');
    await uploadReadyBook(owner, ws.id, 'book-en');
    await signInAs(page, owner.user);
    const form = await openEditor(page, ws.id);
    const trigger = questionFormUi.chapter(form);
    await trigger.click();

    const group = page
      .getByRole('tree')
      .getByRole('treeitem', { expanded: true, level: 1 })
      .filter({ hasNotText: CH1 })
      .first();
    await expect(group).toBeVisible();
    await expect(group).not.toHaveAttribute('aria-selected');
    const title = await group.getAttribute('aria-label');
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('tree')).toBeVisible();
    await expect(trigger).toContainText(NONE);
    await group.click();

    await chapterPickerUi.row(page, CH1).click();
    await expect(trigger).toContainText(`${CH1} (${title})`);
  },
);
