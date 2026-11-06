// QIMPORT-02 — the question PDF import page in two panes: the `검토할 PDF` list on the left and the
// selected PDF's review on the right (`/workspaces/:id/questions/import?document=:id`),
// docs/screens/questions-import-layout.md. The review itself is QIMPORT-01's (questions-import.spec.ts).
//
// Data: fixtures/ux9-pages.ts (`seedReviewPdfs`: A paper with an extraction and one registered
// draft, B 교재+문제 with an older extraction, C 교재+문제 waiting for 문제 추출, D paper held in
// processing, E book; `seedLargeReview`: 512 drafts). The synthetic paper yields 8 drafts, so the
// AC's draft counts are the runs' own counts read from the API.
import type { Page, Request, Route } from '@playwright/test';
import {
  expect,
  expectProgressSteps,
  homePath,
  importUi,
  JOB_TIMEOUT_MS,
  main,
  questionPaper,
  seedMembership,
  signInAs,
  test,
  uploadPdf,
  waitForJob,
} from '../fixtures/test.ts';
import {
  draftCountsText,
  importDocumentPath,
  renamedCopy,
  reviewListUi,
  seedLargeReview,
  seedReviewPdfs,
} from '../fixtures/ux9-pages.ts';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 6 * JOB_TIMEOUT_MS });

const DESKTOP = { width: 1280, height: 800 } as const;
const DRAFT_READ = /\/question-imports\/([^/?]+)\/(draft-summaries|drafts)(?:[/?]|$)/;

/** Import run ids whose drafts the browser asked for (summaries or a page of content). */
function recordDraftReads(page: Page): string[] {
  const ids: string[] = [];
  page.on('request', (request: Request) => {
    const match = DRAFT_READ.exec(new URL(request.url()).pathname);
    if (match?.[1]) ids.push(match[1]);
  });
  return ids;
}

test(
  'QIMPORT-02-AC01 the import page lists every PDF to review (title, kind, status) on the left and the selected PDF review on the right',
  { tag: '@infra' },
  async ({ page, workspaceFactory }, testInfo) => {
    await page.setViewportSize(DESKTOP);
    const owner = await workspaceFactory.member('qimport02-ac01');
    const ws = await workspaceFactory.create(owner);
    const pdfs = await seedReviewPdfs(owner, ws.id, testInfo.outputPath('pdfs'));

    await signInAs(page, owner.user);
    const reads = recordDraftReads(page);
    // From 문서 관리's A row (문제 검토), as a user gets there.
    await page.goto(homePath(ws.id, 'panel=documents'));
    await page
      .getByRole('listitem')
      .filter({ hasText: pdfs.a.title })
      .getByRole('link', { name: /문제 검토|review questions/i })
      .click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === importDocumentPath(ws.id) &&
        url.searchParams.get('document') === pdfs.a.id,
    );

    const nav = reviewListUi.nav(page);
    await expect(nav).toBeVisible();
    await expect(reviewListUi.heading(page)).toHaveText(/\(4\)$/);
    // A · B (extractions, newest first), then D · C (no extraction, newest upload first); no E.
    const rows = reviewListUi.rows(nav);
    await expect(rows).toHaveCount(4);
    for (const [i, pdf] of pdfs.order.entries()) await expect(rows.nth(i)).toContainText(pdf.title);
    await expect(rows.filter({ hasText: pdfs.e.title })).toHaveCount(0);

    const row = (title: string) => reviewListUi.row(nav, title);
    await expect(row(pdfs.a.title).getByText('문제지', { exact: true })).toBeVisible();
    await expect(row(pdfs.a.title)).toContainText(
      draftCountsText(pdfs.a.run.draft_count, pdfs.a.run.published_count),
    );
    await expect(row(pdfs.b.title).getByText('교재+문제', { exact: true })).toBeVisible();
    await expect(row(pdfs.b.title)).toContainText(draftCountsText(pdfs.b.run.draft_count, 0));
    await expect(row(pdfs.c.title).getByText('교재+문제', { exact: true })).toBeVisible();
    await expect(row(pdfs.c.title)).toContainText(/추출 전|not extracted/i);
    await expect(reviewListUi.extract(row(pdfs.c.title))).toBeVisible();
    // D: the abbreviated 업로드 → 분석 → 색인 steps, state as text.
    await expect(row(pdfs.d.title).getByText('문제지', { exact: true })).toBeVisible();
    await expectProgressSteps(row(pdfs.d.title), [
      [/업로드|upload/i, 'done'],
      [/분석|pars|analy/i, 'current'],
      [/색인|index/i, 'pending'],
    ]);
    // The row's title link is the PDF's review; the current one is marked as such (not by colour only).
    await expect(reviewListUi.link(nav, pdfs.a.title)).toHaveAttribute('aria-current', 'page');
    await expect(reviewListUi.link(nav, pdfs.b.title)).not.toHaveAttribute('aria-current', 'page');
    await expect(reviewListUi.link(nav, pdfs.b.title)).toHaveAttribute(
      'href',
      new RegExp(`[?&]document=${pdfs.b.id}(&|$)`),
    );

    // The right pane: A's review.
    await expect(reviewListUi.reviewTitle(page, pdfs.a.title)).toBeVisible();
    await expect(importUi.draftItems(page)).toHaveCount(pdfs.a.run.draft_count);
    await expect(importUi.selectAll(page)).toBeVisible();
    await expect(importUi.publish(page)).toBeVisible();
    // The list sits left of the review; the old `검토할 PDF` combobox is gone.
    const [navBox, draftsBox] = await Promise.all([
      nav.boundingBox(),
      importUi.drafts(page).boundingBox(),
    ]);
    expect(navBox && draftsBox && navBox.x + navBox.width <= draftsBox.x).toBe(true);
    await expect(importUi.pdfSwitcher(page)).toHaveCount(0);

    // Drawing the list read no other PDF's drafts.
    await page.waitForLoadState('networkidle');
    expect(reads.filter((id) => id !== pdfs.a.run.id)).toEqual([]);
  },
);

test(
  'QIMPORT-02-AC02 choosing a row pushes ?document= (Back and Forward walk the PDFs), no ?document= replaces it with the newest extraction, a foreign id is not found',
  { tag: '@infra' },
  async ({ page, browserName, workspaceFactory }, testInfo) => {
    await page.setViewportSize(DESKTOP);
    const owner = await workspaceFactory.member('qimport02-ac02');
    const ws = await workspaceFactory.create(owner);
    const pdfs = await seedReviewPdfs(owner, ws.id, testInfo.outputPath('pdfs'));
    const stranger = await workspaceFactory.member('qimport02-ac02-foreign');
    const foreignWs = await workspaceFactory.create(stranger);
    const foreignTitle = 'qimport02-foreign-secret-paper';
    const foreign = await uploadPdf(
      stranger,
      foreignWs.id,
      renamedCopy(questionPaper(), testInfo.outputPath('foreign'), foreignTitle),
      'question_paper',
    );
    await waitForJob(stranger, foreign.jobId);

    const atDocument = (id: string) => (url: URL) =>
      url.pathname === importDocumentPath(ws.id) && url.searchParams.get('document') === id;

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    await page.goto(importDocumentPath(ws.id, pdfs.a.id));
    const nav = reviewListUi.nav(page);
    await expect(reviewListUi.link(nav, pdfs.a.title)).toHaveAttribute('aria-current', 'page');

    // Mouse: B's review, focus on its title, A's drafts gone.
    await reviewListUi.link(nav, pdfs.b.title).click();
    await expect(page).toHaveURL(atDocument(pdfs.b.id));
    const bTitle = reviewListUi.reviewTitle(page, pdfs.b.title);
    await expect(bTitle).toBeFocused();
    await expect(importUi.draftItems(page)).toHaveCount(pdfs.b.run.draft_count);
    await expect(reviewListUi.link(nav, pdfs.b.title)).toHaveAttribute('aria-current', 'page');

    // Keyboard: Tab onto A's row link, Enter (WebKit, like Safari, reaches links with Option+Tab).
    const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    const aLink = reviewListUi.link(nav, pdfs.a.title);
    for (let i = 0; i < 40 && !(await aLink.evaluate((el) => el === document.activeElement)); i++)
      await page.keyboard.press(tab);
    await expect(aLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(atDocument(pdfs.a.id));
    await expect(reviewListUi.reviewTitle(page, pdfs.a.title)).toBeFocused();
    await expect(importUi.draftItems(page)).toHaveCount(pdfs.a.run.draft_count);

    // One history entry per row: Back → B, Back → A, Forward → B.
    await page.goBack();
    await expect(page).toHaveURL(atDocument(pdfs.b.id));
    await expect(reviewListUi.reviewTitle(page, pdfs.b.title)).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(atDocument(pdfs.a.id));
    await expect(reviewListUi.reviewTitle(page, pdfs.a.title)).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(atDocument(pdfs.b.id));
    await expect(importUi.draftItems(page)).toHaveCount(pdfs.b.run.draft_count);

    // Without ?document=: the newest extraction (A), written in place (Back goes home).
    await page.goto(homePath(ws.id));
    await page.goto(importDocumentPath(ws.id));
    await expect(page).toHaveURL(atDocument(pdfs.a.id));
    await expect(reviewListUi.link(nav, pdfs.a.title)).toHaveAttribute('aria-current', 'page');
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === homePath(ws.id));

    // Another workspace's document: not found, with the list; nothing of it in the response.
    const response = await page.goto(importDocumentPath(ws.id, foreign.documentId));
    await expect(reviewListUi.notFound(page)).toBeVisible();
    await expect(reviewListUi.rows(nav)).toHaveCount(4);
    const html = (await response?.text()) ?? '';
    expect(html).not.toContain(foreignTitle);
    expect(html).not.toContain(questionPaper().questions[0]?.stem ?? '');
    await expect(main(page)).not.toContainText(foreignTitle);
  },
);

const REVIEW_PAGE_SIZE = 100;

test(
  'QIMPORT-02-AC03 switching PDFs with checked drafts asks first; a large review still pages its drafts and a late page never lands on the other PDF',
  { tag: '@infra' },
  async ({ page, workspaceFactory }, testInfo) => {
    await page.setViewportSize(DESKTOP);
    const owner = await workspaceFactory.member('qimport02-ac03');
    const ws = await workspaceFactory.create(owner);
    const { a, b } = await seedLargeReview(owner, ws.id, testInfo.outputPath('pdfs'));
    const atDocument = (id: string) => (url: URL) => url.searchParams.get('document') === id;

    // Page reads of A by offset; the read of page 3 is held until released.
    const offsets: number[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let heldDone: () => void = () => undefined;
    const heldFinished = new Promise<void>((resolve) => (heldDone = resolve));
    await page.route(
      new RegExp(`/question-imports/${a.run.id}/drafts\\?`),
      async (route: Route) => {
        const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
        offsets.push(offset);
        if (offset === 2 * REVIEW_PAGE_SIZE) {
          await held;
          await route.continue().catch(() => undefined);
          heldDone();
          return;
        }
        await route.continue();
      },
    );

    await signInAs(page, owner.user);
    await page.goto(importDocumentPath(ws.id, a.id));
    const nav = reviewListUi.nav(page);
    await expect(reviewListUi.link(nav, a.title)).toHaveAttribute('aria-current', 'page');
    // QIMP-PAGING: the summary of all 512, one page of 100 rendered.
    await expect(importUi.draftsHeading(page)).toContainText(`${a.total}개`, { timeout: 30_000 });
    await expect(importUi.draftItems(page)).toHaveCount(REVIEW_PAGE_SIZE);
    // QIMP-REVIEW-SCALE: closed chapter pickers hold no options.
    await expect(importUi.drafts(page).getByRole('combobox', { name: /번 문제 챕터/ })).toHaveCount(
      REVIEW_PAGE_SIZE,
    );
    await expect(page.getByRole('treeitem')).toHaveCount(0);

    // Three checked drafts (1, 2, 4 have answers in the paper).
    const pick = (n: number) =>
      main(page).getByRole('checkbox', { name: `${n}번 문제 선택`, exact: true });
    for (const n of [1, 2, 4]) await pick(n).check();
    await expect(importUi.publish(page)).toContainText('(3)');

    // Cancel keeps A and the selection.
    await reviewListUi.link(nav, b.title).click();
    const confirm = reviewListUi.switchConfirm(page);
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(reviewListUi.switchConfirmText(3));
    await reviewListUi.cancelSwitch(confirm).click();
    await expect(confirm).toHaveCount(0);
    await expect(page).toHaveURL(atDocument(a.id));
    for (const n of [1, 2, 4]) await expect(pick(n)).toBeChecked();
    await expect(importUi.publish(page)).toContainText('(3)');

    // 바꾸기 switches to B; A's selection is gone when coming back.
    await reviewListUi.link(nav, b.title).click();
    await reviewListUi.confirmSwitch(reviewListUi.switchConfirm(page)).click();
    await expect(page).toHaveURL(atDocument(b.id));
    await expect(importUi.draftItems(page)).toHaveCount(b.run.draft_count);
    await reviewListUi.link(nav, a.title).click();
    await expect(reviewListUi.switchConfirm(page)).toHaveCount(0);
    await expect(page).toHaveURL(atDocument(a.id));
    await expect(importUi.draftItems(page)).toHaveCount(REVIEW_PAGE_SIZE);
    for (const n of [1, 2, 4]) await expect(pick(n)).not.toBeChecked();

    // Page 3 is still loading when B is chosen: its late response never changes B's screen.
    await importUi.pagerPage(importUi.pager(page), 3).click();
    await expect.poll(() => offsets).toContain(2 * REVIEW_PAGE_SIZE);
    await reviewListUi.link(nav, b.title).click();
    await expect(page).toHaveURL(atDocument(b.id));
    await expect(importUi.draftItems(page)).toHaveCount(b.run.draft_count);
    release();
    await heldFinished;
    await page.waitForLoadState('networkidle');
    await expect(importUi.draftsHeading(page)).toContainText(`${b.run.draft_count}개`);
    await expect(importUi.draftItems(page)).toHaveCount(b.run.draft_count);
    await expect(importUi.draftItems(page).filter({ hasText: / #\d+/ })).toHaveCount(0);
    await expect(reviewListUi.reviewTitle(page, b.title)).toBeVisible();
  },
);

test(
  'QIMPORT-02-AC04 a phone opens the list as a bottom sheet; a viewer sees the list without actions; no question PDF shows the empty state only',
  { tag: '@infra' },
  async ({ page, browser, workspaceFactory, turnstile }, testInfo) => {
    const owner = await workspaceFactory.member('qimport02-ac04');
    const ws = await workspaceFactory.create(owner);
    const pdfs = await seedReviewPdfs(owner, ws.id, testInfo.outputPath('pdfs'));
    const viewer = await workspaceFactory.member('qimport02-ac04-viewer');
    seedMembership(ws.id, viewer.user.id, 'viewer');
    const empty = await workspaceFactory.create(owner);
    seedMembership(empty.id, viewer.user.id, 'viewer');

    // Phone (375px, touch).
    const phone = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      viewport: { width: 375, height: 740 },
      hasTouch: true,
      isMobile: true,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      reducedMotion: 'reduce',
    });
    try {
      await turnstile.install(phone);
      const mobile = await phone.newPage();
      await signInAs(mobile, owner.user);
      await mobile.goto(importDocumentPath(ws.id, pdfs.a.id));
      await expect(reviewListUi.nav(mobile)).toHaveCount(0);
      const opener = reviewListUi.sheetButton(mobile);
      await expect(opener).toBeVisible();
      await expect(opener).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(opener).toContainText(pdfs.a.title);
      await expect(opener).toContainText(
        draftCountsText(pdfs.a.run.draft_count, pdfs.a.run.published_count),
      );
      await opener.tap();
      const sheet = reviewListUi.sheet(mobile);
      await expect(sheet).toBeVisible();
      await expect(sheet).toHaveAttribute('aria-modal', 'true');
      const sheetRows = reviewListUi.rows(sheet);
      await expect(sheetRows).toHaveCount(4);
      for (const [i, pdf] of pdfs.order.entries())
        await expect(sheetRows.nth(i)).toContainText(pdf.title);
      await reviewListUi.link(sheet, pdfs.b.title).tap();
      await expect(mobile).toHaveURL((url) => url.searchParams.get('document') === pdfs.b.id);
      await expect(sheet).toHaveCount(0);
      await expect(importUi.draftItems(mobile)).toHaveCount(pdfs.b.run.draft_count);
      await expect(reviewListUi.sheetButton(mobile)).toContainText(pdfs.b.title);
      const overflow = await mobile.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'no horizontal page scroll at 375px').toBeLessThanOrEqual(0);
    } finally {
      await phone.close();
    }

    // Viewer (desktop): the same list and review, without 문제 추출, registering or editing.
    await page.setViewportSize(DESKTOP);
    await signInAs(page, viewer.user);
    await page.goto(importDocumentPath(ws.id, pdfs.a.id));
    const nav = reviewListUi.nav(page);
    await expect(reviewListUi.rows(nav)).toHaveCount(4);
    await expect(reviewListUi.row(nav, pdfs.c.title)).toContainText(/추출 전|not extracted/i);
    await expect(
      main(page).getByRole('button', { name: /문제 추출|extract questions/i }),
    ).toHaveCount(0);
    await expect(importUi.draftItems(page)).toHaveCount(pdfs.a.run.draft_count);
    await expect(importUi.publish(page)).toHaveCount(0);
    await expect(
      importUi.drafts(page).getByRole('button', { name: /^(편집|수정|edit)/i }),
    ).toHaveCount(0);

    // A workspace without question PDFs: the empty state only, no list.
    await page.goto(importDocumentPath(empty.id));
    await expect(reviewListUi.empty(page)).toBeVisible();
    await expect(reviewListUi.nav(page)).toHaveCount(0);
    await expect(reviewListUi.sheetButton(page)).toHaveCount(0);
  },
);
