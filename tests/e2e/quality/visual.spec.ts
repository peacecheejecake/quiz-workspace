// M7.2 visual baselines (docs/e2e-strategy.md §4/§7): key screens in light and dark, on the
// `visual-desktop` (1280×800) and `visual-ipad` (834×1194 portrait, touch) projects.
//
// Determinism: the browser runs in the pinned Playwright container (same fonts and rasterizer on
// macOS and CI, see tests/e2e/README.md "Visual baselines"); locale ko-KR, Asia/Seoul, reduced
// motion, animations disabled, caret hidden, web fonts awaited. Data is per-test but its visible
// text is fixed (workspace names, question labels, synthetic PDFs); what still varies (dates and
// times, ids) is masked, the account and `<time>` masks at fixed widths. An MCQ the practice
// panel shows in its per-session shuffled order has one text for every option, so any order
// renders the same pixels.
// Share secrets never appear in a screenshot: the shared view is captured after the fragment
// exchange, the owner's one-time link field is not captured.
import type { Locator, Page } from '@playwright/test';
import { COLOR_SCHEMES } from '../fixtures/a11y.ts';
import {
  answerCorrectly,
  authUi,
  createNumberedQuestions,
  docUi,
  numberedMcq,
  documentsPath,
  editorUi,
  expectCaptchaVerified,
  JOB_TIMEOUT_MS,
  overviewPath,
  openSearchOptions,
  overviewUi,
  panelUi,
  runSearch,
  searchPath,
  searchUi,
  setMyState,
  signInAs,
  snippet,
  uploadReadyBook,
  wsUi,
  block,
  book,
  createQuestion,
  homeUi,
  listDocuments,
  mcqInput,
  outlineNodeId,
  RESULT_TEXT,
  waitForJob,
  type Question,
} from '../fixtures/test.ts';
import { MOCK_TEXT, mockExamsPath, mockUi, STATUS_TEXT } from '../fixtures/mock-exams.ts';
import { goToResults, runUi } from '../fixtures/practice-runs.ts';
import { rangePickerUi } from '../fixtures/range-picker.ts';
import {
  createShareLink,
  expect,
  expectFragmentRemoved,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  seedSharedContent,
  sharedUi,
  sharingSettingsPath,
  sharingUi,
  test,
} from '../fixtures/sharing.ts';
import { generateNote, notePanelPath, noteQuestion, noteUi } from '../fixtures/chapter-notes.ts';
import { exportUi } from '../fixtures/export.ts';
import { expectFitsViewport, expectSplit, viewerUi } from '../fixtures/document-viewer.ts';
import {
  startSummary,
  summaryPanelPath,
  summaryUi,
  waitForSummaryRun,
} from '../fixtures/summary.ts';

test.use(NO_VISUAL_ARTIFACTS);
test.describe.configure({ timeout: JOB_TIMEOUT_MS + 90_000 });

const BOOK = book('book-ko');
const PANEL_QUESTION = 3;
const PANEL_OPTION = 'visual-3 보기';

/** The header account button (UX1), which shows the per-test email. A CSS selector, not
 *  `authUi.accountButton`: a modal dialog hides the header from the accessibility tree, and a role
 *  locator would then leave the email unmasked. */
const ACCOUNT_BUTTON = 'button[aria-label^="계정 "][title]';
/** The email is a UUID in a proportional font, so the button's width, and with it the mask box,
 *  would vary per run: it gets one fixed, narrow width before capturing (right-aligned, so nothing
 *  else in the header moves; narrow, so the mask covers less of a side panel drawn over it). A page
 *  style: the screenshot `style` option left the mask boxes at the unstyled width. */
const FIXED_ACCOUNT_WIDTH = `${ACCOUNT_BUTTON} { width: 12rem !important; }`;
/** A timestamp's text width depends on the date ("10. 29." vs "11. 2."), and so would its mask box
 *  and the inline text after it (the documents row's "· 56.3 KB"): every `<time>` gets one fixed
 *  width, wider than any "yyyy. m. d. 오후 h:mm", on one line (anything longer is clipped, under
 *  the mask). */
const FIXED_TIME_WIDTH =
  'time { display: inline-block !important; width: 10rem !important; overflow: hidden !important; white-space: nowrap !important; vertical-align: top !important; }';

/** Dynamic regions: timestamps (server dates, relative times) and the account button's email. */
function dynamic(page: Page): Locator[] {
  return [
    page.locator('time'),
    page.locator('[data-visual-dynamic]'),
    page.locator(ACCOUNT_BUTTON),
  ];
}

async function ready(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Full-page screenshot of the current state in every color scheme: `<name>-<scheme>.png`. */
async function snap(page: Page, name: string, extraMask: Locator[] = []): Promise<void> {
  await page.addStyleTag({ content: `${FIXED_ACCOUNT_WIDTH}\n${FIXED_TIME_WIDTH}` });
  for (const scheme of COLOR_SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await ready(page);
    await expect(page).toHaveScreenshot(`${name}-${scheme}.png`, {
      fullPage: true,
      mask: [...dynamic(page), ...extraMask],
    });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('VISUAL-01 sign-in and sign-up forms, with field errors', async ({ page }) => {
  await page.goto('/login');
  await expect(authUi.email(page)).toBeVisible();
  // Settled security check (A4, deterministic fake Turnstile in its "passed" state).
  await expectCaptchaVerified(page);
  await snap(page, 'login');
  await page.goto('/signup');
  await authUi.signUpButton(page).click();
  await expect(page.locator('[aria-invalid="true"]').first()).toBeVisible();
  await expectCaptchaVerified(page);
  await page.mouse.move(0, 0);
  await snap(page, 'signup-errors');
});

test(
  'VISUAL-02 workspace home and documents library',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('visual02');
    const ws = await workspaceFactory.create(owner, '정수 처리 스터디');
    await workspaceFactory.create(owner, '알고리즘 문제집');
    await uploadReadyBook(owner, ws.id, 'book-ko');
    await signInAs(page, owner.user);
    await expect(wsUi.item(wsUi.tabPanel(page), '정수 처리 스터디')).toBeVisible();
    await snap(page, 'workspaces');
    await wsUi.createButton(page).click();
    await expect(wsUi.createDialog(page)).toBeVisible();
    await snap(page, 'workspaces-create-dialog');
    await page.keyboard.press('Escape');

    await page.goto(documentsPath(ws.id));
    await expect(docUi.ready(docUi.item(page, /book-ko|물의 순환과 정수 처리/))).toBeVisible();
    await snap(page, 'documents');
  },
);

test(
  'VISUAL-03 questions heatmap (statuses, favorite star, retry) and the practice panel',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('visual03');
    const ws = await workspaceFactory.create(owner, '문제 풀이');
    // The practice panel shows question 3 in a per-session CSPRNG option order (QPLAY-01): its
    // four options share one text, so every order renders the same pixels while the rows,
    // numbers and borders stay in the baseline (no mask, no test-only seed in the API).
    const qs = await createNumberedQuestions(owner, ws.id, 'visual', 24, (n) =>
      n === PANEL_QUESTION
        ? numberedMcq('visual', n, 0, {
            options: [1, 2, 3, 4].map((i) => ({ id: `opt-${i}`, text: PANEL_OPTION })),
          })
        : numberedMcq('visual', n),
    );
    const at = (n: number) => {
      const q = qs[n - 1];
      if (!q) throw new Error(`question ${n}`);
      return q;
    };
    await answerCorrectly(owner, at(1));
    await answerCorrectly(owner, at(2));
    await setMyState(owner, at(2).id, { is_favorite: true });
    await setMyState(owner, at(5).id, { is_favorite: true });
    await setMyState(owner, at(7).id, { needs_retry: true });

    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(24);
    await page.mouse.move(0, 0);
    await snap(page, 'questions-overview');
    // The 본문 search's settings popover over the home (UX7-SEARCH: the 본문 search is expanded).
    await openSearchOptions(page, 'body');
    await page.mouse.move(0, 0);
    await snap(page, 'search-options');
    await page.keyboard.press('Escape');

    await overviewUi.dot(page, PANEL_QUESTION).click();
    const panel = panelUi.numbered(page, PANEL_QUESTION);
    await expect(panel).toBeVisible();
    // Pre-submission (no answer state); every displayed option carries the shared text.
    await expect(panel.getByRole('radio', { name: PANEL_OPTION })).toHaveCount(4);
    await snap(page, 'practice-panel');
    await panelUi.close(panel).click();
    await expect(panel).toHaveCount(0);
  },
);

test(
  'VISUAL-04 search results with the excerpt panel, and the document editor',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('visual04');
    const ws = await workspaceFactory.create(owner, '검색 연습');
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    await signInAs(page, owner.user);

    const target = block(BOOK, 'ch1-s2-p1');
    await page.goto(searchPath(ws.id));
    await runSearch(page, snippet(target.text, 10), 'keyword');
    await expect(searchUi.resultItems(page).first()).toBeVisible();
    await searchUi.resultItems(page).first().getByRole('button').first().click();
    await expect(searchUi.excerptPanel(page)).toBeVisible();
    await page.mouse.move(0, 0);
    await snap(page, 'search-excerpt');

    // DOCVIEW-01 default layout (함께 보기 · 좌우; docked outline on desktop, collapsed on iPad).
    await page.goto(`/workspaces/${ws.id}/documents/${documentId}`);
    await expect(viewerUi.settingsBar(page)).toBeVisible();
    await expect(editorUi.textPanel(page)).toBeVisible();
    await expect(editorUi.viewer(page).locator('canvas').first()).toBeVisible();
    await expectFitsViewport(page);
    await snap(page, 'document-editor');
  },
);

test(
  'VISUAL-05 sharing settings (off) and the guest shared view',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('visual05');
    const ws = await workspaceFactory.create(owner, '공유 스터디');
    await seedSharedContent(owner, ws.id);
    await signInAs(page, owner.user);
    await page.goto(sharingSettingsPath(ws.id));
    await expect(sharingUi.offStatus(page)).toBeVisible();
    await snap(page, 'sharing-off');

    const link = await createShareLink(owner, ws.id);
    await page.context().clearCookies();
    await openShareWithSecret(page, link.id, link.secret);
    await expect(sharedUi.readOnlyNotice(page)).toBeVisible();
    await expectFragmentRemoved(page, link.id);
    await expect(sharedUi.questions(page)).toBeVisible();
    await snap(page, 'shared-view');
  },
);

test(
  'VISUAL-06 text export menu, document summary panel and chapter note panel (body folded)',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('visual06');
    const ws = await workspaceFactory.create(owner, '요약 스터디');
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const title = (await listDocuments(owner, ws.id)).find((d) => d.id === documentId)?.title;
    if (!title) throw new Error('uploaded document is not listed');
    await startSummary(owner, documentId);
    await waitForSummaryRun(owner, documentId, 'succeeded');
    const chapter = await outlineNodeId(owner, documentId, '1장 물의 순환');
    for (let n = 1; n <= 3; n += 1) {
      await createQuestion(
        owner,
        ws.id,
        noteQuestion('visual', n, chapter, 'ok', {
          sources: [{ document_id: documentId, page_start: 2, page_end: 3 }],
        }),
      );
    }
    await generateNote(owner, chapter);
    await signInAs(page, owner.user);

    // DOC-03: the 문서 관리 row's export menu.
    await page.goto(documentsPath(ws.id));
    await expect(homeUi.documentsDialog(page)).toBeVisible();
    const row = docUi.item(page, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await expect(docUi.ready(row)).toBeVisible();
    // Opened by keyboard: the first item has focus (a stable focus ring, no hover).
    await exportUi.rowButton(row).focus();
    await page.keyboard.press('Enter');
    await expect(exportUi.item(page, 'md')).toBeFocused();
    await snap(page, 'documents-export-menu');
    await page.keyboard.press('Escape');

    // DOCSUM-01: the done summary (meta line holds the publish time).
    await page.goto(summaryPanelPath(ws.id, documentId));
    const summary = summaryUi.panel(page);
    await expect(summaryUi.overallHeading(summary)).toBeVisible();
    await page.mouse.move(0, 0);
    await snap(page, 'document-summary', [summaryUi.meta(summary)]);

    // CHNOTE-01: the note with its body folded behind "정답·해설 포함" (answers never captured).
    await page.goto(notePanelPath(ws.id, chapter));
    const note = noteUi.panel(page);
    await expect(noteUi.disclosure(note)).toHaveAttribute('aria-expanded', 'false');
    await page.mouse.move(0, 0);
    await snap(page, 'chapter-note', [noteUi.meta(note)]);
  },
);

test(
  'VISUAL-08 document viewer layout: outline open, outline collapsed, 상하 with 변환본 first',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('visual08');
    const ws = await workspaceFactory.create(owner, '보기 설정');
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    await signInAs(page, owner.user);
    await page.goto(`/workspaces/${ws.id}/documents/${documentId}`);
    await expect(viewerUi.settingsBar(page)).toBeVisible();
    const pdfReady = async () => {
      await expect(editorUi.textPanel(page)).toBeVisible();
      await expect(editorUi.viewer(page).locator('canvas').first()).toBeVisible();
      await expectFitsViewport(page);
      await page.mouse.move(0, 0);
    };

    // Default layout (함께 보기 · 좌우 · 원본 먼저) with the outline open: docked beside the panes
    // on desktop; on the iPad (tablet width) it starts collapsed and opens as an opaque overlay.
    const toggle = viewerUi.outlineToggle(page);
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(viewerUi.outlinePanel(page)).toBeVisible();
    await expectSplit(page, { orientation: 'horizontal', first: 'pdf', pdfRatio: 50 });
    await pdfReady();
    await snap(page, 'document-viewer-outline-open');

    await viewerUi.collapseOutline(page).click();
    await expect(viewerUi.outlinePanel(page)).toBeHidden();
    await expect(viewerUi.expandOutline(page)).toHaveAttribute('aria-expanded', 'false');
    await pdfReady();
    await snap(page, 'document-viewer-outline-collapsed');

    // 상하 with 변환본 on top (위치 바꾸기), outline still collapsed.
    await viewerUi.orientation(page, 'vertical').click();
    await viewerUi.swapButton(page).click();
    await expectSplit(page, { orientation: 'vertical', first: 'text', pdfRatio: 50 });
    await pdfReady();
    await snap(page, 'document-viewer-vertical-text-first');
  },
);

const PHONE = { width: 375, height: 812 };

/** `snap`, plus the 375 px phone width on the desktop project (`<name>-375-<scheme>.png`; the
 *  iPad project keeps its own viewport only). */
async function snapEvery(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0);
  await snap(page, name);
  if (test.info().project.name !== 'visual-desktop') return;
  const viewport = page.viewportSize();
  await page.setViewportSize(PHONE);
  await snap(page, `${name}-375`);
  if (viewport) await page.setViewportSize(viewport);
}

/** VISUAL-07 questions: fixed stems and option texts (one per chapter position). */
const VISUAL07_QUESTIONS: readonly (readonly [chapter: 1 | 2, stem: string, options: string[]])[] =
  [
    [1, '햇빛을 받은 물이 수증기로 바뀌는 과정은?', ['증발', '응결', '강수', '침투']],
    [1, '수증기가 식어 작은 물방울이 되는 과정은?', ['응결', '증발', '유출', '증산']],
    [1, '구름 속 물방울이 땅으로 떨어지는 현상은?', ['강수', '응결', '침투', '증발']],
    [2, '작은 입자를 뭉쳐 큰 덩어리로 만드는 단계는?', ['응집', '침전', '여과', '소독']],
    [2, '물속 병원성 미생물을 줄이는 마지막 단계는?', ['소독', '응집', '침전', '여과']],
  ];

test(
  'VISUAL-07 모의고사 list, create options and range steps, detail, and the QuestionViewer range picker and results summary',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('visual07');
    const ws = await workspaceFactory.create(owner, '모의고사 스터디');
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const chapters = {
      1: await outlineNodeId(owner, documentId, '1장 물의 순환'),
      2: await outlineNodeId(owner, documentId, '2장 정수 처리'),
    } as const;
    const numbers = { 1: 0, 2: 0 };
    const questions: Question[] = [];
    for (const [chapter, stem, options] of VISUAL07_QUESTIONS) {
      numbers[chapter] += 1;
      questions.push(
        await createQuestion(owner, ws.id, {
          ...mcqInput(stem, options, 0),
          explanation: `${options[0]}: 해설`,
          chapter_id: chapters[chapter],
          question_number: numbers[chapter],
        }),
      );
    }
    // 보기 섞기 only (no LLM) with fixed seeds; every question of the range is taken, in Heatmap
    // order, so the rows are the same on every run.
    const exams: { id: string; job: string }[] = [];
    for (const [title, range, count] of [
      ['1장 복습', { all: false, chapter_ids: [chapters[1]] }, 3],
      ['중간 점검', { all: true }, 5],
    ] as const) {
      const exam = await owner.api.ok<{ id: string; latest_generation: { job_id: string } }>(
        'POST',
        `/workspaces/${ws.id}/mock-exams`,
        {
          title,
          config: { variation_types: ['OPTION_SHUFFLE'], question_count: count },
          range,
          seed: 4711,
        },
        [202],
      );
      exams.push({ id: exam.id, job: exam.latest_generation.job_id });
    }
    for (const exam of exams) await waitForJob(owner, exam.job);
    const [, midterm] = exams;
    if (!midterm) throw new Error('no mock exam');

    await signInAs(page, owner.user);
    await page.goto(mockExamsPath(ws.id));
    const dialog = mockUi.dialog(page);
    await expect(mockUi.rows(dialog)).toHaveCount(2);
    await expect(mockUi.row(dialog, '중간 점검')).toContainText(STATUS_TEXT.ready);
    await expect(mockUi.row(dialog, '1장 복습')).toContainText(STATUS_TEXT.ready);
    await snapEvery(page, 'mock-exams-list');

    // 만들기: options (default name, 문구 변형 checked) and the range (1장 open, 1장 1번 off).
    await mockUi.add(dialog).click();
    await expect(mockUi.variations(dialog)).toHaveCount(4);
    await mockUi.title(dialog).fill('기말 대비');
    for (const type of ['OPTION_SHUFFLE', 'INVERT_POLARITY', 'ANALOGOUS_CONCEPT'] as const) {
      const box = mockUi.variation(dialog, type);
      if (await box.isChecked()) await box.uncheck();
    }
    await mockUi.variation(dialog, 'PARAPHRASE').check();
    await mockUi.questionCount(dialog).fill('4');
    await snapEvery(page, 'mock-exams-create-options');
    await mockUi.next(dialog).click();
    await rangePickerUi.selectAll(dialog).check();
    await rangePickerUi.expand(dialog, '1장 물의 순환').click();
    await rangePickerUi.question(dialog, 1, 1).uncheck();
    await expect(rangePickerUi.selected(dialog, 4)).toBeVisible();
    await expect(dialog.getByText(MOCK_TEXT.aiNotice)).toBeVisible();
    await snapEvery(page, 'mock-exams-create-range');

    // The detail (round 1, five 보기 섞기 copies; no answer shown in the rows).
    await page.goto(mockExamsPath(ws.id, midterm.id));
    await expect(mockUi.heading(dialog, '중간 점검')).toBeVisible();
    await expect(mockUi.questions(dialog)).toHaveCount(5);
    await snapEvery(page, 'mock-exams-detail');

    // QuestionViewer: the range picker (전체 선택 mixed, 1장 open) ...
    await page.goto(overviewPath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(5);
    await homeUi.questionMenuButton(page).click();
    await runUi.menuItem(page).click();
    let panel = runUi.panel(page);
    await expect(runUi.pickerTitle(panel)).toBeVisible();
    await expect(runUi.busy(panel)).toHaveCount(0);
    await runUi.selectAll(panel).check();
    await runUi.expand(panel, '1장 물의 순환').click();
    await runUi.question(panel, 1, 2).uncheck();
    await expect(runUi.selectAll(panel)).toHaveAttribute('aria-checked', 'mixed');
    await snapEvery(page, 'question-viewer-range');

    // ... and the results summary of a 2장 run: one correct, one skipped (graded positions with
    // their answer and explanation are never captured).
    // From mixed, one click selects everything and the next clears it.
    for (
      let i = 0;
      i < 2 && (await runUi.selectAll(panel).getAttribute('aria-checked')) !== 'false';
      i += 1
    ) {
      await runUi.selectAll(panel).click();
    }
    await expect(runUi.selectAll(panel)).toHaveAttribute('aria-checked', 'false');
    await runUi.chapter(panel, '2장 정수 처리').check();
    await runUi.start(panel).click();
    panel = runUi.panel(page);
    await expect(runUi.title(panel, 2, 1)).toBeVisible();
    await runUi.option(panel, '응집').check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await runUi.next(panel).click();
    await expect(runUi.title(panel, 2, 2)).toBeVisible();
    await goToResults(panel);
    await expect(
      runUi.summary(panel, { correct: 1, incorrect: 0, pending: 0, skipped: 1 }),
    ).toBeVisible();
    await snapEvery(page, 'question-viewer-results');
    expect(questions).toHaveLength(5);
  },
);
