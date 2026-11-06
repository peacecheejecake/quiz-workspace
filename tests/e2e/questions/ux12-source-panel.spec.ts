// UX12-SOURCE: source page links open the 원본 PDF dialog in place; the URL stays, focus returns to
// the link and a practice surface before submission has no way to it
// (docs/screens/ux12-source-panel.md).
import { devices, type Locator, type Page } from '@playwright/test';
import { questionPaper, waitForLatestImport } from '../fixtures/questions.ts';
import { addImportLocation, sourceUi } from '../fixtures/question-source.ts';
import {
  addImportedSource,
  ANSWER,
  ANSWER_PAGE,
  APPLIED_PAGE,
  createSourcedQuestion,
  expandRelated,
  listBlocks,
  relatedUi,
  relsrcInput,
  seedRelsrcBook,
} from '../fixtures/related-sources.ts';
import {
  startSummary,
  summaryPanelPath,
  summaryUi,
  waitForSummaryRun,
} from '../fixtures/summary.ts';
import {
  book,
  choosePanelMenu,
  createQuestion,
  detailUi,
  editorUi,
  expect,
  importUi,
  JOB_TIMEOUT_MS,
  mcqInput,
  overviewPath,
  overviewUi,
  pageLabel,
  panelUi,
  RESULT_TEXT,
  runSearch,
  searchPath,
  searchUi,
  signInAs,
  sourcePdfUi,
  test,
  uploadPdf,
  uploadQuestionPaper,
  uploadReadyBook,
  waitForJob,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const AGAIN = /^다시 풀기$|^solve again$/i;

/** Clicks `link` and checks the dialog opened at `pageNumber` with the URL left as it was. */
async function openInPlace(page: Page, link: Locator, pageNumber: number): Promise<Locator> {
  const before = page.url();
  await link.click();
  const dialog = sourcePdfUi.dialog(page);
  await expect(dialog).toBeVisible();
  // After the page is drawn: the viewer must stay there, not only start there.
  await expect(
    dialog.getByRole('img', {
      name: new RegExp(`^(PDF ${pageNumber}쪽|PDF page ${pageNumber})$`, 'i'),
    }),
  ).toBeVisible();
  await expect(sourcePdfUi.currentPage(dialog)).toHaveValue(String(pageNumber));
  expect(page.url()).toBe(before);
  return dialog;
}

test(
  'UX12-SOURCE-AC01 a draft page link opens the compare panel at that page and focus returns to it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const paper = questionPaper();
    const owner = await workspaceFactory.member('ux12-source-ac01');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await uploadQuestionPaper(page, ws.id, paper);
    await expect(importUi.draftItems(page)).toHaveCount(paper.questions.length, {
      timeout: JOB_TIMEOUT_MS,
    });

    const question = paper.questions[paper.questions.length - 1];
    if (!question) throw new Error('the paper has questions');
    const draft = importUi.draft(page, question.stem);
    const link = draft.getByRole('button', { name: pageLabel(question.page) });
    const dialog = await openInPlace(page, link, question.page);
    await expect(dialog).toContainText(
      new RegExp(`지금 보는 쪽: ${question.page}쪽|current page: ${question.page}`, 'i'),
    );
    await expect(sourcePdfUi.fullDocument(dialog)).toHaveAttribute(
      'href',
      new RegExp(`[?&]page=${question.page}(&|$)`),
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(link).toBeFocused();

    // 원본 비교 keeps its own focus return, to the draft last shown.
    await importUi.compare(draft).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /이전 초안|previous draft/i }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('button[data-compare-draft]:focus')).toHaveCount(1);
  },
);

test(
  'UX12-SOURCE-AC02 a 문제 상세 source opens over the dialog, which stays open after Escape',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-source-ac02');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    await createQuestion(owner, ws.id, {
      ...mcqInput('출처 dialog 문제', ['가', '나', '다', '라'], 1),
      question_number: 1,
      sources: [{ document_id: documentId, page_start: 2, page_end: 3 }],
    });
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await expect(panel).toBeVisible();
    await choosePanelMenu(page, panel, 'history');
    const detail = detailUi.dialog(page);
    await expect(detailUi.sourcesHeading(detail)).toBeVisible();

    const link = detail.getByRole('button', { name: /2–3쪽|pages? 2/i });
    const dialog = await openInPlace(page, link, 2);
    await expect(sourcePdfUi.fullDocument(dialog)).toHaveAttribute(
      'href',
      `/workspaces/${ws.id}/documents/${documentId}?page=2`,
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(detail).toBeVisible();
    await expect(link).toBeFocused();
  },
);

test(
  'UX12-SOURCE-AC03 after submitting, 관련 본문 opens the dialog beside the panel and 전체 문서 보기 leaves for DOC-02',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-source-ac03');
    const ws = await workspaceFactory.create(owner);
    const relsrc = await seedRelsrcBook(owner, ws.id);
    await createSourcedQuestion(owner, ws.id, relsrc, {
      ...relsrcInput('ux12-source-ac03', relsrc),
      question_number: 1,
    });
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await panelUi.option(panel, ANSWER).check();
    await panelUi.submit(panel).click();
    await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
    const body = await expandRelated(panel);

    // The row's PDF button: the panel stays visible beside the dialog.
    const panelBox = await panel.boundingBox();
    const pdf = relatedUi.pdf(relatedUi.row(body, 1));
    const dialog = await openInPlace(page, pdf, APPLIED_PAGE);
    const dialogBox = await dialog.boundingBox();
    expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0)).toBeLessThanOrEqual(panelBox?.x ?? 0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(pdf).toBeFocused();

    // The excerpt panel's PDF에서 보기.
    await relatedUi.open(relatedUi.row(body, 0)).click();
    const excerpt = relatedUi.excerptPanel(page);
    await expect(excerpt).toBeVisible();
    const inPdf = relatedUi.openInPdf(excerpt);
    await openInPlace(page, inPdf, ANSWER_PAGE);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(inPdf).toBeFocused();

    await inPdf.click();
    await sourcePdfUi.fullDocument(dialog).click();
    await expect(page).toHaveURL(
      (url) => url.pathname === `/workspaces/${ws.id}/documents/${relsrc.documentId}`,
    );
    await expect(editorUi.currentPage(page)).toHaveValue(String(ANSWER_PAGE));
    // The page is drawn: DOC-02's viewer opens while the dialog's closes.
    await expect(editorUi.pdfPage(page, ANSWER_PAGE)).toBeVisible();
  },
);

async function openChlorineExcerpt(page: Page, workspaceId: string): Promise<Locator> {
  await page.goto(searchPath(workspaceId));
  await runSearch(page, 'chlorine', 'keyword');
  const hit = searchUi
    .resultItems(page)
    .filter({ hasText: /chlorine/i })
    .first();
  await hit.getByRole('button').first().click();
  const panel = searchUi.excerptPanel(page);
  await expect(panel).toBeVisible();
  return panel;
}

test(
  'UX12-SOURCE-AC04 PDF에서 보기 in the search excerpt opens the dialog and the results stay',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-source-ac04');
    const ws = await workspaceFactory.create(owner);
    await uploadReadyBook(owner, ws.id, 'book-en');
    await signInAs(page, owner.user);
    const panel = await openChlorineExcerpt(page, ws.id);

    const inPdf = searchUi.openInPdf(panel);
    const before = page.url();
    await inPdf.click();
    const dialog = sourcePdfUi.dialog(page);
    await expect(dialog).toBeVisible();
    await expect(sourcePdfUi.fullDocument(dialog)).toBeVisible();
    expect(page.url()).toBe(before);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(inPdf).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(searchUi.resultItems(page).first()).toBeVisible();
  },
);

test.describe('UX12-SOURCE-AC04 phone', () => {
  const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 14'];
  test.use(iphone);

  test(
    'UX12-SOURCE-AC04 on a phone the dialog is a full-screen sheet without a sideways scroll',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const owner = await workspaceFactory.member('ux12-source-ac04-phone');
      const ws = await workspaceFactory.create(owner);
      await uploadReadyBook(owner, ws.id, 'book-en');
      await signInAs(page, owner.user);
      const panel = await openChlorineExcerpt(page, ws.id);
      await searchUi.openInPdf(panel).click();
      const dialog = sourcePdfUi.dialog(page);
      await expect(dialog).toBeVisible();
      await expect(sourcePdfUi.fullDocument(dialog)).toBeVisible();
      const viewport = page.viewportSize();
      const box = await dialog.boundingBox();
      expect(box?.width).toBe(viewport?.width);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);

      // Back closes only the sheet.
      const before = page.url();
      await page.goBack();
      await expect(dialog).toBeHidden();
      await expect(panel).toBeVisible();
      expect(page.url()).toBe(before);
    },
  );

  test(
    'UX12-SOURCE-AC04 on a phone 전체 문서 보기 replaces the sheet entry, so one Back returns and the next leaves',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const owner = await workspaceFactory.member('ux12-source-ac04-back');
      const ws = await workspaceFactory.create(owner);
      const documentId = await uploadReadyBook(owner, ws.id, 'book-en');
      await signInAs(page, owner.user);
      const panel = await openChlorineExcerpt(page, ws.id);
      const searchUrl = page.url();
      await searchUi.openInPdf(panel).click();
      await sourcePdfUi.fullDocument(sourcePdfUi.dialog(page)).click();
      await expect(page).toHaveURL(
        (url) => url.pathname === `/workspaces/${ws.id}/documents/${documentId}`,
      );

      await page.goBack();
      await expect(page).toHaveURL(searchUrl);
      await expect(searchUi.resultItems(page).first()).toBeVisible();

      // Not the same screen a second time: the sheet's history entry is gone.
      await page.goBack();
      await expect(page).not.toHaveURL(searchUrl);
    },
  );
});

test(
  'UX12-SOURCE-AC05 a summary page link opens the first page of its range and the panel stays',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-source-ac05');
    const ws = await workspaceFactory.create(owner);
    const { documentId, jobId } = await uploadPdf(owner, ws.id, book('book-ko'));
    await waitForJob(owner, jobId);
    await startSummary(owner, documentId);
    await waitForSummaryRun(owner, documentId, 'succeeded');
    await signInAs(page, owner.user);
    await page.goto(summaryPanelPath(ws.id, documentId));
    const panel = summaryUi.panel(page);
    await expect(summaryUi.overallHeading(panel)).toBeVisible();

    const link = summaryUi.pageLinks(summaryUi.keyPoints(panel).first()).first();
    const name = (await link.getAttribute('aria-label')) ?? '';
    const from = Number(/\d+/.exec(name)?.[0]);
    const dialog = await openInPlace(page, link, from);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(link).toBeFocused();
  },
);

test(
  'UX12-SOURCE-AC06 before a submission the practice panel has no way to the whole PDF',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-source-ac06');
    const ws = await workspaceFactory.create(owner);
    const relsrc = await seedRelsrcBook(owner, ws.id);
    const uploaded = await uploadPdf(owner, ws.id, questionPaper(), 'question_paper');
    await waitForJob(owner, uploaded.jobId);
    const run = await waitForLatestImport(owner, ws.id);
    const blocks = (await listBlocks(owner, uploaded.documentId)).items.filter((b) => b.page === 1);
    const question = await createSourcedQuestion(owner, ws.id, relsrc, {
      ...relsrcInput('ux12-source-ac06', relsrc),
      question_number: 1,
    });
    addImportedSource(
      question.id,
      uploaded.documentId,
      run.id,
      1,
      blocks.slice(0, 1).map((b) => b.block_id),
    );
    addImportLocation(question.id, 1, { x0: 40, y0: 40, x1: 340, y1: 120 });

    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await expect(panelUi.submit(panel)).toBeVisible();

    const noWayOut = async () => {
      await expect(relatedUi.toggle(panel)).toHaveCount(0);
      await expect(panel.getByRole('button', { name: /^PDF$/i })).toHaveCount(0);
      await expect(sourcePdfUi.fullDocument(panel)).toHaveCount(0);
    };
    await noWayOut();

    // The cropped 문제 원문 dialog stays cropped: no whole-PDF link.
    await sourceUi.button(panel).click();
    const cropped = sourceUi.dialog(page);
    await expect(sourceUi.figures(cropped).first()).toBeVisible();
    await expect(sourcePdfUi.fullDocument(cropped)).toHaveCount(0);
    await expect(sourcePdfUi.currentPage(cropped)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(cropped).toBeHidden();

    await panelUi.option(panel, ANSWER).check();
    await panelUi.submit(panel).click();
    await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
    const body = await expandRelated(panel);
    await expect(relatedUi.pdf(relatedUi.row(body, 0))).toBeVisible();

    // Solving it again takes the way to the PDF away until the next submission.
    await panel.getByRole('button', { name: AGAIN }).click();
    await expect(panelUi.submit(panel)).toBeVisible();
    await noWayOut();
  },
);
