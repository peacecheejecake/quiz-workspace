// HOMEDLG-01 — every workspace home dialog is modal, dialogs opened inside a dialog (or listed in a
// deep link) stack with only the top one active, and opening or closing a dialog never moves the
// home's content (docs/screens/home-dialogs.md; design-system §5.5).
//
// Modality is asserted as the user meets it: aria-modal="true", focus inside and trapped (Tab and
// Shift+Tab more often than the dialog has controls), the background cut off (`inert` or hidden
// from assistive technology; real mouse clicks on a marker and a header button open nothing).
// Layout (AC03): bounding boxes of the home's parts before / while / after a dialog is open, with
// zero tolerance, in desktop Chromium with classic (space-taking) scrollbars — Playwright launches
// Chromium with --hide-scrollbars, which this file drops — and an iPad Pro
// 11 viewport (WebKit in the authenticated-webkit project). Openers there are clicked through the
// DOM (`dispatchEvent`): a real click would first scroll the off-screen header button into view,
// which would be the test moving the page, not the app.
import { devices, type Locator, type Page } from '@playwright/test';
import {
  archiveQuestion,
  createQuestion,
  detailUi,
  expect,
  homePath,
  homeUi,
  inactiveUi,
  JOB_TIMEOUT_MS,
  listDocuments,
  outlineNodeId,
  overviewUi,
  panelUi,
  signInAs,
  test,
  uploadReadyBook,
  type Member,
  type Question,
} from '../fixtures/test.ts';
import { generateNote, noteQuestion, noteUi } from '../fixtures/chapter-notes.ts';
import { getSummary, startSummary, summaryUi, waitForSummaryRun } from '../fixtures/summary.ts';
import {
  expectFocusTrapped,
  hasFocusWithin,
  homeBackgroundUi,
  homeDialogUi,
  isBlocked,
  settleAnimations,
} from '../fixtures/ux9-pages.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({ storageState: { cookies: [], origins: [] } });
// Classic, space-taking scrollbars in Chromium (AC03); a worker option, so it is file-wide.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });
test.describe.configure({ timeout: 3 * JOB_TIMEOUT_MS });

const CH1 = '1장 물의 순환';
const CH2 = '2장 정수 처리';
const DESKTOP = { width: 1280, height: 800 } as const;

interface HomeSetup {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly ch1: string;
  readonly questions: readonly Question[];
}

/**
 * book-ko, `perChapter` confirmed questions in each of its two chapters (chapter 1's with the
 * APP_ENV=test note scenario marker) and a generated note for chapter 1.
 */
async function homeWithContent(
  workspaceFactory: WorkspaceFactory,
  label: string,
  perChapter: number,
): Promise<HomeSetup> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
  const ch1 = await outlineNodeId(owner, documentId, CH1);
  const ch2 = await outlineNodeId(owner, documentId, CH2);
  const questions: Question[] = [];
  for (const [chapter, offset] of [
    [ch1, 0],
    [ch2, perChapter],
  ] as const) {
    for (let start = 1; start <= perChapter; start += 10) {
      const batch = Array.from(
        { length: Math.min(10, perChapter - start + 1) },
        (_, i) => offset + start + i,
      );
      questions.push(
        ...(await Promise.all(
          batch.map((n) => createQuestion(owner, ws.id, noteQuestion(label, n, chapter, 'ok'))),
        )),
      );
    }
  }
  await generateNote(owner, ch1);
  const title = (await listDocuments(owner, ws.id)).find((d) => d.id === documentId)?.title;
  return {
    owner,
    workspaceId: ws.id,
    documentId,
    documentTitle: title ?? 'book-ko',
    ch1,
    questions,
  };
}

const panels = (page: Page) => new URL(page.url()).searchParams.getAll('panel');

/** Opens the header `문제` menu and chooses the item named `item`. */
async function fromQuestionMenu(page: Page, item: RegExp): Promise<void> {
  await homeUi.questionMenuButton(page).click();
  await page
    .getByRole('menu', { name: /^(문제|questions)$/i })
    .getByRole('menuitem', { name: item })
    .click();
}

interface HomeDialog {
  readonly name: string;
  readonly panel: string;
  readonly dialog: (page: Page) => Locator;
  readonly open: (page: Page) => Promise<void>;
  /** Where focus returns when the dialog closes. */
  readonly opener: (page: Page) => Locator;
}

const DIALOGS: readonly HomeDialog[] = [
  {
    name: '문서 관리',
    panel: 'documents',
    dialog: homeDialogUi.documents,
    open: (page) => homeUi.documentsButton(page).click(),
    opener: homeUi.documentsButton,
  },
  {
    name: '중복 문제 정리',
    panel: 'question-duplicates',
    dialog: homeDialogUi.duplicates,
    open: (page) => fromQuestionMenu(page, /^(중복 문제 정리|duplicate questions)$/i),
    opener: homeUi.questionMenuButton,
  },
  {
    name: '보관·초안 문제',
    panel: 'inactive-questions',
    dialog: homeDialogUi.inactive,
    open: (page) => fromQuestionMenu(page, /^(보관·초안 문제|archived and draft questions)$/i),
    opener: homeUi.questionMenuButton,
  },
  {
    name: '모의고사',
    panel: 'mock-exams',
    dialog: homeDialogUi.mockExams,
    open: (page) => fromQuestionMenu(page, /^(모의고사|mock exams?)$/i),
    opener: homeUi.questionMenuButton,
  },
  {
    name: '이력',
    panel: 'history',
    dialog: homeDialogUi.history,
    open: (page) => homeUi.historyButton(page).click(),
    opener: homeUi.historyButton,
  },
  {
    name: '링크 공유',
    panel: 'share',
    dialog: homeDialogUi.share,
    open: (page) => homeUi.shareButton(page).click(),
    opener: homeUi.shareButton,
  },
  {
    name: '챕터 재분배',
    panel: 'chapter-redistribution',
    dialog: homeDialogUi.redistribution,
    open: (page) => fromQuestionMenu(page, /^(챕터 재분배|redistribute chapters)$/i),
    opener: homeUi.questionMenuButton,
  },
  {
    name: '정리 노트',
    panel: 'chapter-note',
    dialog: homeDialogUi.chapterNote,
    open: (page) => noteUi.opener(page, CH1).click(),
    opener: (page) => noteUi.opener(page, CH1),
  },
];

/** The dialog is modal: aria-modal, focus inside, the home behind it cut off. */
async function expectModal(page: Page, dialog: Locator, label: string): Promise<void> {
  await expect(dialog, label).toBeVisible();
  await expect(dialog, `${label} is modal`).toHaveAttribute('aria-modal', 'true');
  await expect.poll(() => hasFocusWithin(dialog), `${label}: focus inside`).toBe(true);
  const marker = homeBackgroundUi.dots(page).first();
  expect(await isBlocked(marker), `${label}: heatmap inert`).toBe(true);
  const header = homeBackgroundUi.questionMenuButton(page);
  expect(await isBlocked(header), `${label}: header inert`).toBe(true);
}

test(
  'HOMEDLG-01-AC01 each home dialog is a modal dialog: focus stays inside, the home behind is inert, Escape closes it back to its opener',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.setViewportSize(DESKTOP);
    const s = await homeWithContent(workspaceFactory, 'homedlg01-ac01', 3);
    const home = homePath(s.workspaceId);

    await signInAs(page, s.owner.user);
    await page.goto('/workspaces');
    await page.goto(home);
    await expect(overviewUi.dots(page)).toHaveCount(s.questions.length);

    for (const d of DIALOGS) {
      await d.open(page);
      const dialog = d.dialog(page);
      await expectModal(page, dialog, d.name);
      expect(panels(page), d.name).toEqual([d.panel]);
      await expectFocusTrapped(page, dialog);

      // Escape (focus inside) closes it, focus back on its opener, `panel=` gone. A 정리 노트
      // footnote's keyboard preview takes the first Escape (CHNOTE-02 "키보드").
      if ((await page.getByRole('tooltip').count()) > 0) {
        await page.keyboard.press('Escape');
        await expect(page.getByRole('tooltip')).toHaveCount(0);
      }
      await page.keyboard.press('Escape');
      await expect(dialog, d.name).toHaveCount(0);
      await expect(d.opener(page), `${d.name}: focus back on its opener`).toBeFocused();
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === home &&
          !url.searchParams.has('panel') &&
          !url.searchParams.has('chapter'),
      );
      // Neither Back nor Forward reopens it (QOV-01-AC14).
      await page.goBack();
      await expect(page).toHaveURL((url) => url.pathname === '/workspaces');
      await page.goForward();
      await expect(page).toHaveURL(
        (url) => url.pathname === home && !url.searchParams.has('panel'),
      );
      await expect(overviewUi.dots(page).first()).toBeVisible();
      await expect(d.dialog(page), `${d.name} after Back/Forward`).toHaveCount(0);

      // A real click on a marker, then on a header button, with the dialog open (reopened and
      // on top before each probe): the click may land on the backdrop and close a dialog that
      // has nothing to lose, but never activates what is behind it.
      const marker = await overviewUi.dots(page).first().boundingBox();
      // The `문서 n` button: the home no longer steps aside (AC03), so at 1280px the `문제` menu
      // button lies under the 500px dialog itself (a click there lands inside the dialog, not on
      // its backdrop); `문서 n` stays left of every dialog.
      const header = await homeUi.documentsButton(page).boundingBox();
      if (!marker || !header) throw new Error('home controls are not visible');
      for (const [what, box] of [
        ['marker', marker],
        ['header button', header],
      ] as const) {
        await d.open(page);
        await expectModal(page, dialog, `${d.name} before the ${what} click`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        const probe = `${d.name}, ${what} click`;
        await expect(panelUi.panel(page), `${probe}: no question panel`).toHaveCount(0);
        await expect(page.getByRole('menu'), `${probe}: no menu`).toHaveCount(0);
        const url = new URL(page.url());
        expect(url.searchParams.has('question'), `${probe}: no question=`).toBe(false);
        expect(
          url.searchParams.getAll('panel').every((p) => p === d.panel),
          `${probe}: no other panel`,
        ).toBe(true);
        // Closed by the backdrop or still open: either way, close it before the next probe.
        if (await dialog.isVisible()) {
          await page.keyboard.press('Escape');
        }
        await expect(dialog).toHaveCount(0);
      }
    }
  },
);

test(
  'HOMEDLG-01-AC02 dialogs opened inside a dialog or listed in a deep link stack modally; Escape and Back close them from the top',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.setViewportSize(DESKTOP);
    const s = await homeWithContent(workspaceFactory, 'homedlg01-ac02', 2);
    if (!(await getSummary(s.owner, s.documentId)).run) await startSummary(s.owner, s.documentId);
    await waitForSummaryRun(s.owner, s.documentId, 'succeeded');
    const [archived] = s.questions;
    if (!archived) throw new Error('no question');
    await archiveQuestion(s.owner, archived);
    const home = homePath(s.workspaceId);

    await signInAs(page, s.owner.user);
    await page.goto('/workspaces');
    await page.goto(home);
    await expect(overviewUi.dots(page).first()).toBeVisible();

    // 문서 관리 → 요약: the summary stacks on top, 문서 관리 below it is inert.
    await homeUi.documentsButton(page).click();
    const documents = homeDialogUi.documents(page);
    await expectModal(page, documents, '문서 관리');
    const summaryButton = summaryUi.rowButton(documents, s.documentTitle);
    await summaryButton.click();
    const summary = homeDialogUi.summary(page);
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAttribute('aria-modal', 'true');
    await expect(documents).toBeVisible();
    expect(await isBlocked(documents), '문서 관리 under 문서 요약').toBe(true);
    await expect.poll(() => hasFocusWithin(summary)).toBe(true);
    await expectFocusTrapped(page, summary);
    // Back closes the top one only (focus back on 요약), Back again closes 문서 관리.
    await page.goBack();
    await expect(summary).toHaveCount(0);
    await expect(documents).toBeVisible();
    expect(await isBlocked(documents)).toBe(false);
    await expect(summaryButton).toBeFocused();
    await page.goBack();
    await expect(documents).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.pathname === home && !url.searchParams.has('panel'));

    // 보관·초안 문제 → 문제 상세: Escape closes one at a time from the top.
    await fromQuestionMenu(page, /^(보관·초안 문제|archived and draft questions)$/i);
    const inactive = homeDialogUi.inactive(page);
    await expectModal(page, inactive, '보관·초안 문제');
    const row = inactiveUi.row(inactive, archived.revision.stem);
    await inactiveUi.open(row).click();
    const detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    await expect(detail).toHaveAttribute('aria-modal', 'true');
    expect(await isBlocked(inactive), '보관·초안 문제 under 문제 상세').toBe(true);
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
    await expect(inactive).toBeVisible();
    expect(await isBlocked(inactive)).toBe(false);
    await expect.poll(() => hasFocusWithin(inactive)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(inactive).toHaveCount(0);
    await expect(homeUi.questionMenuButton(page)).toBeFocused();

    // A deep link with two home dialogs opens both, in URL order, the last one on top.
    const both = homePath(s.workspaceId, 'panel=documents&panel=mock-exams');
    await page.goto(both);
    const mock = homeDialogUi.mockExams(page);
    await expect(mock).toBeVisible();
    await expect(documents).toBeVisible();
    await expect(mock).toHaveAttribute('aria-modal', 'true');
    await expect(documents).toHaveAttribute('aria-modal', 'true');
    await expect.poll(() => hasFocusWithin(mock)).toBe(true);
    expect(await isBlocked(documents), '문서 관리 under 모의고사').toBe(true);
    expect(panels(page)).toEqual(['documents', 'mock-exams']);
    // Escape closes 모의고사 only; 문서 관리 is active again.
    await page.keyboard.press('Escape');
    await expect(mock).toHaveCount(0);
    await expect(documents).toBeVisible();
    expect(panels(page)).toEqual(['documents']);
    expect(await isBlocked(documents)).toBe(false);
    await expect.poll(() => hasFocusWithin(documents)).toBe(true);
    // Back then closes 문서 관리; Forward does not reopen either.
    await page.goBack();
    await expect(documents).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.pathname === home && !url.searchParams.has('panel'));
    await page.goForward();
    await expect(documents).toHaveCount(0);
    await expect(mock).toHaveCount(0);

    // The nested combination as a deep link: 문서 요약 on top of 문서 관리.
    await page.goto(
      homePath(s.workspaceId, `panel=documents&panel=document-summary&document=${s.documentId}`),
    );
    await expect(summary).toBeVisible();
    await expect(documents).toBeVisible();
    await expect.poll(() => hasFocusWithin(summary)).toBe(true);
    expect(await isBlocked(documents), '문서 관리 under 문서 요약 (deep link)').toBe(true);

    // Mixed dialog types in one deep link: the centered 문제 등록 editor, then 문서 관리 on top —
    // the active (last) dialog is also the one drawn on top, its backdrop over the editor.
    await page.goto(homePath(s.workspaceId, 'panel=question-create&panel=documents'));
    const editor = page.getByRole('dialog', {
      name: /^(문제 등록|new question)$/i,
      includeHidden: true,
    });
    await expect(editor).toBeVisible();
    await expect(documents).toBeVisible();
    await expect.poll(() => hasFocusWithin(documents)).toBe(true);
    expect(await isBlocked(editor), '문제 등록 under 문서 관리').toBe(true);
    const z = (l: Locator) => l.evaluate((el) => Number(getComputedStyle(el).zIndex));
    expect(await z(documents), '문서 관리 drawn above 문제 등록').toBeGreaterThan(await z(editor));
    // What is under the dialog's own first control is that control (not the editor's backdrop).
    const close = documents.getByRole('button', { name: /문서 관리 닫기|close/i });
    const hit = await close.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return top !== null && el.contains(top);
    });
    expect(hit, '문서 관리 receives the pointer').toBe(true);
  },
);

// ---------------------------------------------------------------------------------------------
// HOMEDLG-01-AC03 — layout does not move
// ---------------------------------------------------------------------------------------------

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Layout {
  readonly boxes: Readonly<Record<string, Box>>;
  readonly clientWidth: number;
  readonly scrollY: number;
  readonly bodyPaddingRight: string;
  readonly bodyMarginRight: string;
}

/** getBoundingClientRect of the home's parts (exact, unrounded) plus the scroll root's metrics. */
async function measure(page: Page, parts: Readonly<Record<string, Locator>>): Promise<Layout> {
  const boxes: Record<string, Box> = {};
  for (const [name, locator] of Object.entries(parts)) {
    boxes[name] = await locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  }
  const root = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollY: window.scrollY,
      bodyPaddingRight: body.paddingRight,
      bodyMarginRight: body.marginRight,
    };
  });
  return { boxes, ...root };
}

/** The last marker fully inside the viewport (index among all markers). */
async function lastVisibleMarker(page: Page): Promise<number> {
  return overviewUi.dots(page).evaluateAll((els) =>
    els.reduce((last, el, i) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight ? i : last;
    }, -1),
  );
}

interface LayoutDialog {
  readonly name: string;
  readonly dialog: (page: Page) => Locator;
  /** Opens the dialog without moving the page (DOM click on its opener, see the file comment). */
  readonly open: (page: Page) => Promise<void>;
}

/** Focus without scrolling, as a real click on the button would leave it. */
const focusInPlace = (target: Locator) =>
  target.evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));

/** A DOM click (no scrolling into view) on `target`, focused first like a real click. */
async function domClick(target: Locator): Promise<void> {
  await focusInPlace(target);
  await target.dispatchEvent('click');
}

/**
 * The `문제` menu through the DOM: Radix opens it on pointerdown and focuses its items without
 * scrolling; the item is chosen with a DOM click.
 */
async function domMenu(page: Page, item: RegExp): Promise<void> {
  await focusInPlace(homeUi.questionMenuButton(page));
  await homeUi
    .questionMenuButton(page)
    .dispatchEvent('pointerdown', { button: 0, ctrlKey: false, pointerType: 'mouse' });
  const menuItem = page
    .getByRole('menu', { name: /^(문제|questions)$/i })
    .getByRole('menuitem', { name: item });
  await expect(menuItem).toBeAttached();
  await menuItem.dispatchEvent('click');
}

const LAYOUT_DIALOGS: readonly LayoutDialog[] = [
  {
    name: '문서 관리',
    dialog: homeDialogUi.documents,
    open: (page) => domClick(homeUi.documentsButton(page)),
  },
  {
    name: '정리 노트',
    dialog: homeDialogUi.chapterNote,
    open: (page) => domClick(noteUi.opener(page, CH1)),
  },
  {
    name: '모의고사',
    dialog: homeDialogUi.mockExams,
    open: (page) => domMenu(page, /^(모의고사|mock exams?)$/i),
  },
  {
    name: '이력',
    dialog: homeDialogUi.history,
    open: (page) => domClick(homeUi.historyButton(page)),
  },
];

async function expectStableLayout(
  page: Page,
  workspaceFactory: WorkspaceFactory,
  label: string,
  { classicScrollbar }: { classicScrollbar: boolean },
): Promise<void> {
  const s = await homeWithContent(workspaceFactory, label, 30);
  await signInAs(page, s.owner.user);
  await page.goto(homePath(s.workspaceId));
  await expect(overviewUi.dots(page)).toHaveCount(s.questions.length);
  // Enough page to scroll whatever the marker size: a spacer after the content.
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.setAttribute('aria-hidden', 'true');
    spacer.style.height = '2000px';
    document.body.append(spacer);
  });
  const scrollbar = await page.evaluate(
    () => window.innerWidth - document.documentElement.clientWidth,
  );
  if (classicScrollbar) expect(scrollbar, 'a classic scrollbar takes space').toBeGreaterThan(0);
  // Scrolled down the page, the header out of view and the heatmap's markers in it.
  const firstMarker = overviewUi.dots(page).first();
  const middle = await firstMarker.evaluate((el) => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const y = Math.round(Math.min(max, Math.max(120, top - window.innerHeight / 4)));
    window.scrollTo(0, y);
    return y;
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(middle);

  const last = await lastVisibleMarker(page);
  expect(last, 'a marker is in view').toBeGreaterThanOrEqual(0);
  const parts: Record<string, Locator> = {
    header: homeBackgroundUi.banner(page),
    'workspace header: 문서': homeBackgroundUi.documentsButton(page),
    'workspace header: 이력': homeBackgroundUi.historyButton(page),
    '문제 검색': homeBackgroundUi.questionSearch(page),
    '문제 검색 입력란': homeBackgroundUi.questionSearchBox(page),
    'first chapter group': homeBackgroundUi.chapterGroup(page, CH1),
    'first marker': homeBackgroundUi.dots(page).first(),
    'last visible marker': homeBackgroundUi.dots(page).nth(last),
  };
  const gutter = await page.evaluate(
    () => getComputedStyle(document.documentElement).scrollbarGutter,
  );

  for (const d of LAYOUT_DIALOGS) {
    const before = await measure(page, parts);
    expect(before.bodyPaddingRight, `${d.name}: body padding-right before`).toBe('0px');
    expect(before.bodyMarginRight, `${d.name}: body margin-right before`).toBe('0px');

    await d.open(page);
    const dialog = d.dialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog, `${d.name} is modal`).toHaveAttribute('aria-modal', 'true');
    await settleAnimations(page);
    const during = await measure(page, parts);
    // The scrollbar is hidden while a modal is open (user decision 2026-11-02); its gutter keeps
    // the room, so every box stays put, but Chromium reports the root's clientWidth without the
    // reserved gutter then. The home content's geometry is what must not move.
    expect({ ...during, clientWidth: before.clientWidth }, `${d.name}: layout while open`).toEqual(
      before,
    );

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => hasFocusWithin(page.locator('main'))).toBe(true);
    await settleAnimations(page);
    const after = await measure(page, parts);
    expect(after, `${d.name}: layout after closing`).toEqual(before);
    expect(after.scrollY, `${d.name}: scroll position`).toBe(middle);
  }
  expect(gutter, 'the scroll root keeps its scrollbar gutter').toBe('stable');
}

test.describe('HOMEDLG-01-AC03 desktop Chromium with classic scrollbars', () => {
  test.use({ viewport: DESKTOP });

  test(
    'HOMEDLG-01-AC03 opening and closing home dialogs leaves every home part where it was (desktop, classic scrollbars)',
    { tag: '@infra' },
    async ({ page, workspaceFactory, browserName }) => {
      await expectStableLayout(page, workspaceFactory, 'homedlg01-ac03-desktop', {
        classicScrollbar: browserName === 'chromium',
      });
    },
  );
});

test.describe('HOMEDLG-01-AC03 iPad Pro 11', () => {
  const { defaultBrowserType: _browser, ...ipad } = devices['iPad Pro 11'];
  test.use(ipad);

  test(
    'HOMEDLG-01-AC03 opening and closing home dialogs leaves every home part where it was (iPad)',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await expectStableLayout(page, workspaceFactory, 'homedlg01-ac03-ipad', {
        classicScrollbar: false,
      });
    },
  );
});
