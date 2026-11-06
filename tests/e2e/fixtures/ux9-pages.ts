// UX9.0b fixtures: the data and the role/label UI contract of three UX9 screens (import it
// directly; not re-exported from test.ts):
//
//   QIMPORT-02 (docs/screens/questions-import-layout.md) — the import page's two panes:
//     `nav` "검토할 PDF" (heading h2 "검토할 PDF (n)") holding a `ul` with one row per PDF to review:
//     a link named after the PDF title (`?document=<id>`, the current one aria-current="page"),
//     the DOC-01 kind badge and the status as text, and for editors a separate `문제 추출` button.
//     Below 768px the column is replaced by a button "검토할 PDF" (aria-haspopup="dialog", current
//     title + status) opening a modal bottom sheet dialog "검토할 PDF" with the same rows. Switching
//     with checked drafts asks in a confirm dialog "선택한 초안 k개의 선택이 사라집니다. 다른 PDF로
//     바꿀까요?" (`바꾸기` · `취소`). Unknown ids: "PDF를 찾을 수 없습니다.".
//   SEARCH-02 (docs/screens/search-page.md) — `/workspaces/:id/search`: h1 "본문 검색", BackLink
//     "Workspace 홈", breadcrumb nav "위치" (QOV-01-AC13), a `search` landmark "본문 검색" with the
//     searchbox "본문 검색어", the icon button "검색" and "본문 설정"; results as SEARCH-01
//     (fixtures/workspace-ui.ts `searchUi`); the modal "본문 발췌" panel with `이전 결과`/`다음 결과`.
//     The home's entry is an icon link "본문 검색" right before `이력`.
//   HOMEDLG-01 (docs/screens/home-dialogs.md) — every home dialog is a modal dialog (role=dialog,
//     aria-modal="true"); while one is open the rest of the page is inert (`inert` or hidden from
//     assistive technology, pointer and keyboard). Dialogs are located page-wide: a modal may be
//     portalled outside <main>.
//
// Data (public API, plus fixtures/db.ts uses 4–6 where no public API reaches the state):
//   seedReviewPdfs   QIMPORT-02-AC01: question paper A with an extraction (one draft registered),
//                    교재+문제 B with an extraction (older than A's), 교재+문제 C without one (low
//                    confidence: kind set by hand, extraction not started), question paper D held
//                    in processing without an extraction, and book E. The synthetic paper yields 8
//                    drafts (questions.ts A5), so the AC's "초안 3개 · 등록 1개" becomes the run's own
//                    counts, read from the API.
//   seedLargeReview  QIMPORT-02-AC03: paper A with 512 drafts (8 extracted × 64, db.ts use 5) and
//                    paper B with its 8.
//   paperOnlyWorkspace SEARCH-02-AC04: a workspace whose only published PDF is a question paper.
// Copies of the synthetic PDFs get their own file names (the document title is the file name
// stem), so every row is told apart by its title.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import {
  book,
  JOB_TIMEOUT_MS,
  setDocumentKind,
  uploadPdf,
  uploadReadyBook,
  waitForJob,
  type PdfFile,
} from './documents.ts';
import { forgetImportRuns, holdDocumentProcessing, seedImportDraftCopies } from './db.ts';
import {
  draftFor,
  getImport,
  listDrafts,
  listImports,
  publishDrafts,
  questionPaper,
  startImport,
  truthQuestion,
  type Draft,
  type ImportRun,
  QUESTION_DOT_NAME,
} from './questions.ts';
import { main } from './workspace-ui.ts';
import type { Member } from './workspaces.ts';

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

/** ImportRun with the M4.4a counts (questions.ts A4). */
export interface CountedRun extends ImportRun {
  readonly draft_count: number;
  readonly published_count: number;
}

/** `fixture`'s bytes under `<dir>/<name>.pdf` (title `name`). */
export function renamedCopy(fixture: PdfFile, dir: string, name: string): PdfFile {
  mkdirSync(dir, { recursive: true });
  const file = `${name}.pdf`;
  const path = join(dir, file);
  copyFileSync(fixture.path, path);
  return { ...fixture, file, path };
}

/** Polls until `documentId` has an import run whose job finished; returns it with its counts. */
export async function importOf(
  member: Member,
  workspaceId: string,
  documentId: string,
): Promise<CountedRun> {
  let run: ImportRun | undefined;
  await expect
    .poll(
      async () =>
        (run = (await listImports(member, workspaceId)).find(
          (r) => r.source_document_id === documentId,
        )) !== undefined,
      { message: 'the document has an import run', timeout: JOB_TIMEOUT_MS },
    )
    .toBe(true);
  if (!run) throw new Error('no import run');
  await waitForJob(member, run.job_id);
  return (await getImport(member, run.id)) as CountedRun;
}

export interface ReviewPdf {
  readonly id: string;
  readonly title: string;
}

export interface ReviewPdfs {
  /** Question paper with an extraction (the newest), one draft registered. */
  readonly a: ReviewPdf & { readonly run: CountedRun; readonly drafts: readonly Draft[] };
  /** 교재+문제 with an (older) extraction. */
  readonly b: ReviewPdf & { readonly run: CountedRun };
  /** 교재+문제 without an extraction (low confidence: waits for 문제 추출). */
  readonly c: ReviewPdf;
  /** Question paper held in processing, no extraction. */
  readonly d: ReviewPdf;
  /** Book without questions: never listed. */
  readonly e: ReviewPdf;
  /** The list order: newest extraction first, then the PDFs without one, newest upload first. */
  readonly order: readonly ReviewPdf[];
}

/** QIMPORT-02-AC01's workspace content (see the file comment). `dir` holds the renamed copies. */
export async function seedReviewPdfs(
  owner: Member,
  workspaceId: string,
  dir: string,
): Promise<ReviewPdfs> {
  const paper = questionPaper();
  const e = { id: await uploadReadyBook(owner, workspaceId, 'book-ko'), title: 'book-ko' };

  const bId = await uploadReadyBook(owner, workspaceId, 'book-en');
  await setDocumentKind(owner, bId, 'mixed', false);
  await startImport(owner, workspaceId, bId);
  const bRun = await importOf(owner, workspaceId, bId);
  expect(bRun.status, 'B extraction').toBe('succeeded');

  const aFile = renamedCopy(paper, dir, 'qimport02-a-paper');
  const aUp = await uploadPdf(owner, workspaceId, aFile, 'question_paper');
  await waitForJob(owner, aUp.jobId);
  const aRunStarted = await importOf(owner, workspaceId, aUp.documentId);
  expect(aRunStarted.status, 'A extraction').toBe('succeeded');
  const aDrafts = await listDrafts(owner, aRunStarted.id);
  await publishDrafts(owner, aRunStarted.id, [draftFor(aDrafts, truthQuestion(paper, 1)).id]);
  const aRun = (await getImport(owner, aRunStarted.id)) as CountedRun;
  expect(aRun.published_count, 'A has one registered draft').toBe(1);

  const cFile = renamedCopy(book('book-ko'), dir, 'qimport02-c-mixed');
  const cUp = await uploadPdf(owner, workspaceId, cFile);
  await waitForJob(owner, cUp.jobId);
  const cId = cUp.documentId;
  await setDocumentKind(owner, cId, 'mixed', false);

  const dFile = renamedCopy(paper, dir, 'qimport02-d-processing');
  const dUp = await uploadPdf(owner, workspaceId, dFile, 'question_paper');
  await waitForJob(owner, dUp.jobId);
  await importOf(owner, workspaceId, dUp.documentId);
  forgetImportRuns(workspaceId, dUp.documentId);
  holdDocumentProcessing(dUp.documentId);

  const runs = await listImports(owner, workspaceId);
  expect(
    runs.map((r) => r.source_document_id),
    'only A and B have extractions',
  ).toEqual([aUp.documentId, bId]);

  const a = { id: aUp.documentId, title: 'qimport02-a-paper', run: aRun, drafts: aDrafts };
  const b = { id: bId, title: 'book-en', run: bRun };
  const c = { id: cId, title: 'qimport02-c-mixed' };
  const d = { id: dUp.documentId, title: 'qimport02-d-processing' };
  return { a, b, c, d, e, order: [a, b, d, c] };
}

export interface LargeReview {
  readonly a: ReviewPdf & { readonly run: CountedRun; readonly total: number };
  readonly b: ReviewPdf & { readonly run: CountedRun };
}

/** QIMPORT-02-AC03: paper A with 512 drafts (8 × 64 copies, db.ts use 5) and paper B with 8. */
export async function seedLargeReview(
  owner: Member,
  workspaceId: string,
  dir: string,
): Promise<LargeReview> {
  const paper = questionPaper();
  const bUp = await uploadPdf(
    owner,
    workspaceId,
    renamedCopy(paper, dir, 'qimport02-small'),
    'question_paper',
  );
  await waitForJob(owner, bUp.jobId);
  const bRun = await importOf(owner, workspaceId, bUp.documentId);
  const aUp = await uploadPdf(
    owner,
    workspaceId,
    renamedCopy(paper, dir, 'qimport02-large'),
    'question_paper',
  );
  await waitForJob(owner, aUp.jobId);
  const aRun = await importOf(owner, workspaceId, aUp.documentId);
  const total = seedImportDraftCopies(aRun.id, 63);
  expect(total).toBe(512);
  return {
    a: { id: aUp.documentId, title: 'qimport02-large', run: aRun, total },
    b: { id: bUp.documentId, title: 'qimport02-small', run: bRun },
  };
}

/** SEARCH-02-AC04: the workspace's only published PDF is a question paper (no body to search). */
export async function paperOnlyWorkspace(owner: Member, workspaceId: string): Promise<string> {
  const up = await uploadPdf(owner, workspaceId, book('book-en'), 'question_paper');
  await waitForJob(owner, up.jobId);
  return up.documentId;
}

// ---------------------------------------------------------------------------------------------
// QIMPORT-02 UI
// ---------------------------------------------------------------------------------------------

const REVIEW_LIST = /^(검토할 pdf|pdfs to review)$/i;

export const reviewListUi = {
  nav: (page: Page) => main(page).getByRole('navigation', { name: REVIEW_LIST }),
  heading: (page: Page) =>
    reviewListUi
      .nav(page)
      .getByRole('heading', { level: 2, name: /^(검토할 pdf|pdfs to review) \(\d+\)$/i }),
  /** The rows: the list's own items (a processing row's step list has items of its own). */
  rows: (scope: Locator) => scope.getByRole('list').first().locator(':scope > li'),
  row: (scope: Locator, title: string) =>
    reviewListUi
      .rows(scope)
      .filter({ has: scope.page().getByRole('link', { name: title, exact: true }) }),
  link: (scope: Locator, title: string) =>
    reviewListUi.rows(scope).getByRole('link', { name: title, exact: true }),
  extract: (row: Locator) => row.getByRole('button', { name: /문제 추출|extract questions/i }),
  /** Below 768px: the button that opens the list as a bottom sheet. */
  sheetButton: (page: Page) =>
    main(page).getByRole('button', { name: /검토할 pdf|pdfs to review/i }),
  sheet: (page: Page) => page.getByRole('dialog', { name: REVIEW_LIST }),
  switchConfirm: (page: Page) =>
    page
      .getByRole('alertdialog')
      .or(page.getByRole('dialog'))
      .filter({ hasText: /다른 pdf로 바꿀까요|switch to another pdf/i }),
  switchConfirmText: (k: number) =>
    new RegExp(
      `선택한 초안 ${k}개의 선택이 사라집니다\\. 다른 PDF로 바꿀까요\\?|${k} selected drafts? will be cleared`,
      'i',
    ),
  confirmSwitch: (dialog: Locator) => dialog.getByRole('button', { name: /^(바꾸기|switch)$/i }),
  cancelSwitch: (dialog: Locator) => dialog.getByRole('button', { name: /^(취소|cancel)$/i }),
  notFound: (page: Page) => main(page).getByText(/pdf를 찾을 수 없습니다|pdf not found/i),
  empty: (page: Page) => main(page).getByText(/추출된 문제가 없습니다/),
  /**
   * The review pane's h2 = the selected PDF's title (focus lands on it after a switch); the page
   * h1 stays "문제 PDF 가져오기" (decision 2026-11-02).
   */
  reviewTitle: (page: Page, title: string) =>
    main(page).getByRole('heading', { level: 2, name: title, exact: true }),
};

/** The status text of a row: "초안 n개 · 등록 m개". */
export function draftCountsText(drafts: number, registered: number): RegExp {
  return new RegExp(`초안 ${drafts}개\\s*·\\s*등록 ${registered}개|${drafts} drafts?`, 'i');
}

export function importDocumentPath(workspaceId: string, documentId?: string): string {
  const base = `/workspaces/${workspaceId}/questions/import`;
  return documentId ? `${base}?document=${documentId}` : base;
}

// ---------------------------------------------------------------------------------------------
// SEARCH-02 UI
// ---------------------------------------------------------------------------------------------

const BODY_SEARCH = /^(본문 검색|body search|content search)$/i;

/** The 본문 search page (SEARCH-02), optionally with its query string. */
export function searchPagePath(workspaceId: string, query = ''): string {
  return `/workspaces/${workspaceId}/search${query ? `?${query}` : ''}`;
}

export const searchPageUi = {
  /** The home header's icon link (right before 이력). */
  homeEntry: (page: Page) => main(page).getByRole('link', { name: BODY_SEARCH }),
  heading: (page: Page) => main(page).getByRole('heading', { level: 1, name: BODY_SEARCH }),
  backLink: (page: Page) => main(page).getByRole('link', { name: /workspace 홈|back/i }),
  breadcrumb: (page: Page) => page.getByRole('navigation', { name: /^(위치|breadcrumb)$/i }),
  form: (page: Page) => main(page).getByRole('search', { name: BODY_SEARCH }),
  box: (page: Page) =>
    searchPageUi
      .form(page)
      .getByRole('searchbox', { name: /^(본문 검색어|body search (query|text))$/i }),
  submit: (page: Page) => searchPageUi.form(page).getByRole('button', { name: /^(검색|search)$/i }),
  settingsButton: (page: Page) =>
    main(page).getByRole('button', { name: /^(본문 설정|body settings|content settings)$/i }),
  settings: (page: Page) =>
    page.getByRole('dialog', {
      name: /^(본문 검색 설정|body search settings|content search settings)$/i,
    }),
  intro: (page: Page) => main(page).getByText(/교재 본문에서 찾을 말을 입력하세요/),
  nextResult: (panel: Locator) => panel.getByRole('button', { name: /^(다음 결과|next result)$/i }),
  previousResult: (panel: Locator) =>
    panel.getByRole('button', { name: /^(이전 결과|previous result)$/i }),
};

// ---------------------------------------------------------------------------------------------
// HOMEDLG-01 UI
// ---------------------------------------------------------------------------------------------

/**
 * A dialog by its name, page-wide (a modal may live outside <main>) and including dialogs hidden
 * from assistive technology: one stacked under the top modal is still open, only inert.
 */
const dialogNamed = (page: Page, name: RegExp) =>
  page.getByRole('dialog', { name, includeHidden: true });

export const homeDialogUi = {
  documents: (page: Page) => dialogNamed(page, /^(문서 관리|documents)$/i),
  duplicates: (page: Page) => dialogNamed(page, /^(중복 문제 정리|duplicate questions)$/i),
  inactive: (page: Page) => dialogNamed(page, /^(보관·초안 문제|archived and draft questions)$/i),
  mockExams: (page: Page) => dialogNamed(page, /^(모의고사|mock exams?)$/i),
  history: (page: Page) => dialogNamed(page, /^(이력|history)$/i),
  share: (page: Page) => dialogNamed(page, /^(링크 공유|share link)$/i),
  redistribution: (page: Page) => dialogNamed(page, /^(챕터 재분배|redistribute chapters)$/i),
  chapterNote: (page: Page) => dialogNamed(page, /^(정리 노트|chapter notes?)$/i),
  summary: (page: Page) => dialogNamed(page, /^(문서 요약|document summary)$/i),
  detail: (page: Page) => dialogNamed(page, /^(문제 상세|question details?)$/i),
};

/**
 * The home's own parts, found even while a modal hides them from assistive technology (the
 * fixtures/workspace-ui.ts locators go through the accessibility tree and miss them then).
 */
export const homeBackgroundUi = {
  banner: (page: Page) => page.getByRole('banner', { includeHidden: true }).first(),
  documentsButton: (page: Page) =>
    page
      .locator('main')
      .getByRole('button', { name: /^(문서|documents)\s*\d+$/i, includeHidden: true }),
  historyButton: (page: Page) =>
    page.locator('main').getByRole('button', { name: /^(이력|history)$/i, includeHidden: true }),
  questionMenuButton: (page: Page) =>
    page
      .locator('main')
      .getByRole('button', { name: /^(문제 메뉴|question menu)$/i, includeHidden: true }),
  questionSearch: (page: Page) =>
    page.locator('main').getByRole('search', {
      name: /^(문제 검색|question search|search questions)$/i,
      includeHidden: true,
    }),
  questionSearchBox: (page: Page) =>
    homeBackgroundUi.questionSearch(page).getByRole('searchbox', { includeHidden: true }),
  heatmap: (page: Page) =>
    page.locator('main').getByRole('group', { name: /문제 heatmap|heatmap/i, includeHidden: true }),
  dots: (page: Page) =>
    homeBackgroundUi
      .heatmap(page)
      .getByRole('button', { name: QUESTION_DOT_NAME, includeHidden: true }),
  chapterGroup: (page: Page, title: string) =>
    homeBackgroundUi.heatmap(page).getByRole('region', { name: title, includeHidden: true }),
  /** The 본문 search page's result list (SEARCH-02). */
  searchResults: (page: Page) =>
    page
      .locator('main')
      .getByRole('list', { name: /검색 결과|search results/i, includeHidden: true }),
};

/**
 * Whether `target` is cut off from the user while a modal is open: inside an `inert` subtree or
 * hidden from assistive technology (`aria-hidden="true"` on it or an ancestor).
 */
export async function isBlocked(target: Locator): Promise<boolean> {
  return target.evaluate((el) => el.closest('[inert], [aria-hidden="true"]') !== null);
}

/** Whether keyboard focus is inside `scope`. */
export async function hasFocusWithin(scope: Locator): Promise<boolean> {
  return scope.evaluate((el) => el.contains(document.activeElement));
}

/** Tab-reachable controls in `scope` (rough count: enabled, not tabindex=-1). */
export async function tabStops(scope: Locator): Promise<number> {
  return scope.evaluate(
    (el) =>
      el.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
          'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ).length,
  );
}

/**
 * Presses Tab (then Shift+Tab) more often than `dialog` has controls; focus never leaves it.
 */
export async function expectFocusTrapped(page: Page, dialog: Locator): Promise<void> {
  const presses = (await tabStops(dialog)) + 2;
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < presses; i += 1) {
      await page.keyboard.press(key);
      expect(await hasFocusWithin(dialog), `${key} #${i + 1} stays in the dialog`).toBe(true);
    }
  }
}

/** Resolves once every running CSS animation/transition of the document has finished. */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}
