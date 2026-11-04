// M7.2 accessibility of the UX9 screens (UX9-X, docs/e2e-strategy.md §7.1 "UX9 품질 ID"): axe in
// the light and dark theme (fixtures/a11y.ts) on CHREDIST-01 (the list with a chosen target, the
// confirm dialog, the recommendations preview), CHNOTE-02 / HILITE-01 (the note search with
// results, the footnote preview, the highlight menu, `내 하이라이트` and its row menu), QIMPORT-02
// (both panes, and the 375px bottom sheet) and SEARCH-02 (the search page with results and its
// modal excerpt panel), plus keyboard-only redistribution and highlighting.
//
// The note panel and the import review carry answers and explanations (synthetic text only): no
// trace/screenshot/video and no page text on failure; axe reports only rule ids, CSS targets and
// axe's own summaries.
import type { Locator, Page } from '@playwright/test';
import { expectAccessible } from '../fixtures/a11y.ts';
import { noteUi, notePanelPath } from '../fixtures/chapter-notes.ts';
import {
  keyboardChoose,
  openRedistributionByKeyboard,
  redistUi,
  tabTo,
} from '../fixtures/chapter-redistribution.ts';
import {
  chapterHighlights,
  chooseRowItem,
  highlightExplanation,
  highlightNote,
  highlightUi,
  itemText,
  noteSetup,
  noteToolsUi,
  pressUntilFocused,
  SEARCH_MARKER,
  type NoteSetup,
} from '../fixtures/highlights.ts';
import { rangePickerUi } from '../fixtures/range-picker.ts';
import { expect, NO_VISUAL_ARTIFACTS, test } from '../fixtures/sharing.ts';
import {
  block,
  book,
  createQuestion,
  getQuestion,
  importPaperDrafts,
  JOB_TIMEOUT_MS,
  outlineNodeId,
  overviewPath,
  overviewUi,
  searchUi,
  setDocumentKind,
  signInAs,
  snippet,
  uploadPdf,
  uploadReadyBook,
  waitForJob,
  type Question,
} from '../fixtures/test.ts';
import {
  importDocumentPath,
  reviewListUi,
  searchPagePath,
  searchPageUi,
} from '../fixtures/ux9-pages.ts';

test.use({ ...NO_VISUAL_ARTIFACTS, attachPageTextOnFailure: false });
test.describe.configure({ timeout: 3 * JOB_TIMEOUT_MS + 60_000 });

const CH1 = '1장 물의 순환';
const CH2 = '2장 정수 처리';
const PHONE = { width: 375, height: 740 };

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

/** A CONFIRMED MCQ in `chapterId` whose first source is `page` of the book (→ its chapter). */
function sourcedMcq(n: number, chapterId: string, documentId: string, page: number) {
  const options = ['가', '나', '다', '라'].map((x, i) => ({
    id: `opt-${i + 1}`,
    text: `a11y19-${n} 보기 ${x}`,
  }));
  return {
    question_type: 'MCQ' as const,
    stem: `a11y19-${n} 문제: 알맞은 것을 고르시오.`,
    options,
    correct_option_ids: ['opt-1'],
    is_multi_answer: false,
    explanation: `a11y19-${n} 해설.`,
    chapter_id: chapterId,
    question_number: n,
    sources: [{ document_id: documentId, page_start: page, page_end: page }],
  };
}

test(
  'A11Y-19 챕터 재분배 list with a target, the confirm dialog and the recommendations preview; moving and applying by keyboard only',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('a11y19-redist');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const ch1 = await outlineNodeId(owner, documentId, CH1);
    const ch2 = await outlineNodeId(owner, documentId, CH2);
    // 1–3 sit in 1장 by hand but quote page 4 (2장): the preview recommends 2장 for them.
    const qs: Question[] = [];
    for (const n of [1, 2, 3]) {
      qs.push(await createQuestion(owner, ws.id, sourcedMcq(n, ch1, documentId, 4)));
    }
    const [q1] = qs as [Question, Question, Question];

    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await expect(overviewUi.heatmap(page)).toBeVisible();
    const dialog = await openRedistributionByKeyboard(page);
    await expect(rangePickerUi.chapter(dialog, CH1)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'chapter redistribution list');

    // Keyboard only: open 1장, tick question 1, pick 2장, 이동, confirm.
    const expand = rangePickerUi.expand(dialog, CH1);
    await tabTo(page, expand);
    await page.keyboard.press('Enter');
    await expect(expand).toHaveAttribute('aria-expanded', 'true');
    const first = rangePickerUi.question(dialog, 1, 1);
    await tabTo(page, first);
    await page.keyboard.press('Space');
    await expect(first).toBeChecked();
    await expect(redistUi.manualBadge(dialog).first()).toBeVisible();
    const target = redistUi.target(dialog);
    await tabTo(page, target);
    await keyboardChoose(page, target, CH2);
    await expect(redistUi.move(dialog)).toHaveAccessibleName(redistUi.moveCount(1));
    await settle(page);
    await expectAccessible(page, 'chapter redistribution list, question and target chosen');
    await tabTo(page, redistUi.move(dialog));
    await page.keyboard.press('Enter');
    let confirm = redistUi.confirm(page);
    await expect(confirm).toBeVisible();
    await expectAccessible(page, 'chapter redistribution move confirm');
    await tabTo(page, redistUi.confirmMove(confirm), 6);
    await page.keyboard.press('Enter');
    await expect(redistUi.moved(page)).toContainText(/문제 1개를/);
    await expect.poll(async () => (await getQuestion(owner, q1.id)).chapter_id).toBe(ch2);

    // The preview (hand-set chapters included): 2 and 3 → 2장; applied by keyboard.
    const includeManual = redistUi.includeManual(dialog);
    await tabTo(page, includeManual);
    await page.keyboard.press('Space');
    await expect(includeManual).toBeChecked();
    await tabTo(page, redistUi.recommend(dialog));
    await page.keyboard.press('Enter');
    await expect(redistUi.previewRows(dialog)).toHaveCount(2);
    await settle(page);
    await expectAccessible(page, 'chapter redistribution recommendations preview');
    const apply = redistUi.applySelected(dialog);
    await tabTo(page, apply);
    await expect(apply).toHaveAccessibleName(/\(2\)$/);
    await page.keyboard.press('Enter');
    confirm = redistUi.confirm(page);
    await expect(confirm).toBeVisible();
    await expectAccessible(page, 'chapter redistribution apply confirm');
    await tabTo(page, redistUi.confirmMove(confirm), 6);
    await page.keyboard.press('Enter');
    await expect(redistUi.applied(page)).toContainText(/문제 2개의 챕터/);
    for (const q of qs) {
      await expect.poll(async () => (await getQuestion(owner, q.id)).chapter_id).toBe(ch2);
    }
  },
);

/** Q1's stem has "주의", Q2's explanation has "온도 주의 사항" (fixtures/highlights.ts N-SEARCH). */
function searchNote(workspaceFactory: Parameters<typeof noteSetup>[0], label: string) {
  return noteSetup(workspaceFactory, label, {
    count: 2,
    input: (n) =>
      n === 1
        ? { stem: `끓는 물 주의 사항을 고르시오. [${SEARCH_MARKER}]` }
        : {
            stem: `응결이 일어나는 단계를 고르시오. [${SEARCH_MARKER}]`,
            explanation: '응결 해설: 온도 주의 사항을 정리한다.',
          },
  });
}

function question(s: NoteSetup, n: number): Question {
  const found = s.questions[n - 1];
  if (!found) throw new Error(`no question ${n}`);
  return found;
}

/** Presses Tab until focus is inside `scope` (at most `max` presses). */
async function tabInto(page: Page, scope: Locator, max = 40): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await scope.evaluate((el) => el.contains(document.activeElement))) return;
    await page.keyboard.press('Tab');
  }
  expect(await scope.evaluate((el) => el.contains(document.activeElement))).toBe(true);
}

test(
  'A11Y-19 정리 노트 search with results, the footnote preview, the highlight menu and 내 하이라이트 with its row menu; highlighting and recoloring by keyboard only',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await searchNote(workspaceFactory, 'a11y19-note');
    await highlightNote(s.owner, s.note, 0, 1, '주의 깊게', 'yellow');
    await highlightExplanation(s.owner, question(s, 2), '온도 주의 사항', 'pink');
    await signInAs(page, s.owner.user);
    await page.goto(notePanelPath(s.workspaceId, s.ch1));
    const panel = noteUi.panel(page);
    await expect(highlightUi.noteBody(panel)).toBeVisible();
    const section = highlightUi.section(panel);
    await expect(highlightUi.heading(section, 2)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'chapter note with highlights and 내 하이라이트');

    // The search with results (the current one marked by text, not color alone).
    const search = noteToolsUi.search(panel);
    await search.fill('주의');
    await expect(noteToolsUi.count(panel, 1, 6)).toBeVisible();
    await expect(noteToolsUi.current(panel)).toContainText(noteToolsUi.currentLabel);
    await expectAccessible(page, 'chapter note search with results');
    await search.fill('없는말');
    await expect(noteToolsUi.noResults(panel)).toBeVisible();
    await expectAccessible(page, 'chapter note search without results');
    await search.press('Escape');
    await expect(search).toHaveValue('');

    // The footnote preview on keyboard focus (role=tooltip, described-by).
    const ref = highlightUi
      .noteBody(panel)
      .getByRole('link', { name: /^(각주|footnote)\s*1$/i })
      .first();
    await ref.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(ref).toBeFocused();
    await expect(noteToolsUi.preview(page)).toBeVisible();
    await expectAccessible(page, 'chapter note footnote preview');
    await page.keyboard.press('Escape');
    await expect(noteToolsUi.preview(page)).toBeHidden();

    // Keyboard only: Tab into the body, ArrowDown to the item 0.1, Shift+F10 → the menu.
    const body = highlightUi.noteBody(panel);
    await search.focus();
    await tabInto(page, body);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+F10');
    const menu = highlightUi.menu(page);
    await expect(menu).toBeVisible();
    await expect(highlightUi.colorItem(menu, 'yellow')).toBeFocused();
    await expectAccessible(page, 'highlight menu (keyboard, on a highlighted paragraph)');
    // Item 0.1 holds the yellow highlight: blue merges the whole paragraph into one highlight.
    await pressUntilFocused(page, highlightUi.colorItem(menu, 'blue'));
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    const whole = itemText(s.note, 0, 1);
    await expect
      .poll(async () =>
        (await chapterHighlights(s.owner, s.ch1)).map((h) => [h.quote, h.color].join(':')),
      )
      .toContain(`${whole}:blue`);
    await expect(highlightUi.heading(section, 2)).toBeVisible();

    // The row menu and its color submenu, by keyboard: the merged note row turns pink.
    const row = highlightUi.row(section, highlightUi.rowMeta('blue', 'note', '버전 1'));
    await expect(row).toHaveCount(1);
    await chooseRowItem(page, row, 'recolor', true);
    const pink = page
      .getByRole('menuitemradio', { name: /^(분홍|pink)$/i })
      .or(page.getByRole('menuitem', { name: /^(분홍|pink)$/i }));
    await expect(pink.first()).toBeVisible();
    await expectAccessible(page, '내 하이라이트 row menu, color submenu');
    await pressUntilFocused(page, pink.first());
    await page.keyboard.press('Enter');
    await expect(
      highlightUi.row(section, highlightUi.rowMeta('pink', 'note', '버전 1')),
    ).toHaveCount(1);
    await settle(page);
    await expectAccessible(page, '내 하이라이트 after keyboard recolor');
  },
);

test(
  'A11Y-19 문제 PDF 가져오기 list and review panes, and the 375px bottom sheet',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('a11y19-import');
    const ws = await workspaceFactory.create(owner);
    const { run } = await importPaperDrafts(owner, ws.id);
    // A 교재+문제 PDF waiting for 문제 추출 (low confidence: the kind set by hand, no extraction).
    const mixed = await uploadPdf(owner, ws.id, book('book-ko'));
    await waitForJob(owner, mixed.jobId);
    await setDocumentKind(owner, mixed.documentId, 'mixed', false);

    await signInAs(page, owner.user);
    await page.goto(importDocumentPath(ws.id, run.source_document_id));
    const nav = reviewListUi.nav(page);
    await expect(reviewListUi.rows(nav)).toHaveCount(2);
    await expect(reviewListUi.extract(reviewListUi.row(nav, 'book-ko'))).toBeVisible();
    await expect(reviewListUi.reviewTitle(page, 'questions-ko')).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'question import, list and review');

    await page.setViewportSize(PHONE);
    await page.reload();
    const sheetButton = reviewListUi.sheetButton(page);
    await expect(sheetButton).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'question import at 375px');
    await sheetButton.click();
    const sheet = reviewListUi.sheet(page);
    await expect(sheet).toBeVisible();
    await expect(reviewListUi.rows(sheet)).toHaveCount(2);
    await settle(page);
    await expectAccessible(page, 'question import list bottom sheet');
  },
);

test(
  'A11Y-19 본문 검색 page: intro, results and the modal excerpt panel with 이전·다음 결과',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('a11y19-search');
    const ws = await workspaceFactory.create(owner);
    await uploadReadyBook(owner, ws.id, 'book-ko');
    await signInAs(page, owner.user);
    await page.goto(searchPagePath(ws.id));
    await expect(searchPageUi.heading(page)).toBeVisible();
    await expect(searchPageUi.intro(page)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'search page, before a search');

    const target = block(book('book-ko'), 'ch1-s2-p1');
    await page.goto(searchPagePath(ws.id, `text=${encodeURIComponent(snippet(target.text, 6))}`));
    const items = searchUi.resultItems(page);
    await expect(items.first()).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'search page with results');

    await searchUi.excerpt(items.first()).click();
    const panel = searchUi.excerptPanel(page);
    await expect(panel).toBeVisible();
    await expect(searchPageUi.previousResult(panel)).toBeDisabled();
    await settle(page);
    await expectAccessible(page, 'search page excerpt panel');
  },
);
