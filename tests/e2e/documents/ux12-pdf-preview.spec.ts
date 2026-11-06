// UX12-PDFPREVIEW (docs/screens/ux12-pdf-preview.md): a PDF source opens the floating dialog at the
// cited place with the pages around it, and a question whose answer is hidden stays on its crop.
// The answer of `questions-ko.pdf` can be on screen, so no trace, screenshot or video is kept.
import { randomUUID } from 'node:crypto';
import { devices, type Locator, type Page } from '@playwright/test';
import { askPath, askThroughApi, askUi, PASSAGES, seedAskBook } from '../fixtures/ask.ts';
import { boxOf, viewerUi } from '../fixtures/document-viewer.ts';
import { goToResults, openRangePicker, runUi } from '../fixtures/practice-runs.ts';
import {
  correctText,
  seedQuestionSource,
  sourceUi,
  stemOf,
  type SourceSeed,
} from '../fixtures/question-source.ts';
import {
  ANSWER,
  ANSWER_PAGE,
  createSourcedQuestion,
  expandRelated,
  relatedUi,
  relsrcInput,
  seedRelsrcBook,
} from '../fixtures/related-sources.ts';
import { NO_VISUAL_ARTIFACTS } from '../fixtures/sharing.ts';
import {
  choosePanelMenu,
  createQuestion,
  detailUi,
  expect,
  homeUi,
  JOB_TIMEOUT_MS,
  mcqInput,
  overviewPath,
  overviewUi,
  panelUi,
  RESULT_TEXT,
  searchUi,
  signInAs,
  sourcePdfUi,
  test,
  uploadReadyBook,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({
  storageState: { cookies: [], origins: [] },
  ...NO_VISUAL_ARTIFACTS,
});
test.describe.configure({ timeout: 3 * JOB_TIMEOUT_MS + 120_000 });

const DESKTOP = { width: 1280, height: 800 };
const AGAIN = /^다시 풀기$|^solve again$/i;

function unique(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

function pdfPage(scope: Locator, n: number): Locator {
  return scope.getByRole('img', { name: new RegExp(`^(PDF ${n}쪽|PDF page ${n})$`, 'i') });
}

const previewUi = {
  mark: (scope: Locator) => scope.getByRole('img', { name: /^(원문 위치|source location)$/i }),
  pages: (scope: Locator) => scope.getByRole('group', { name: /^(PDF 페이지 영역|pdf pages)$/i }),
};

/** The page after `n` is reachable in the dialog by scrolling, and gets drawn on the way. */
async function expectScrollsTo(dialog: Locator, n: number): Promise<void> {
  await previewUi.pages(dialog).evaluate((element) => {
    element.scrollTop += element.clientHeight * 1.5;
  });
  await expect(pdfPage(dialog, n)).toBeVisible();
}

async function expectCropped(dialog: Locator): Promise<void> {
  await expect(sourceUi.figures(dialog).first()).toBeVisible();
  await expect(previewUi.pages(dialog)).toHaveCount(0);
  await expect(sourcePdfUi.currentPage(dialog)).toHaveCount(0);
  await expect(previewUi.mark(dialog)).toHaveCount(0);
}

async function openHome(page: Page, member: Member, workspaceId: string): Promise<void> {
  await signInAs(page, member.user);
  await page.goto(overviewPath(workspaceId));
  await expect(homeUi.questionMenuButton(page)).toBeVisible();
}

function stemKey(q: Question): string {
  return stemOf(q)
    .replace(/^\s*\d+[.)]\s*/, '')
    .slice(0, 12);
}

async function openImported(page: Page, s: SourceSeed, q: Question): Promise<Locator> {
  await page.goto(overviewPath(s.workspaceId, q.id));
  const panel = page.getByRole('dialog').filter({ hasText: stemKey(q) });
  await expect(panel).toBeVisible();
  return panel;
}

async function submitCorrect(panel: Locator, n: number): Promise<void> {
  await panelUi.option(panel, correctText(n)).check();
  await panelUi.submit(panel).click();
  await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
}

test(
  'UX12-PDFPREVIEW-AC01 before submitting, 문제 원문 shows only the crop: no pages to scroll into the answer',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, unique('pdfpreview-ac01'));
    await page.setViewportSize(DESKTOP);
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openImported(page, s, s.single);
    await sourceUi.button(panel).click();
    const dialog = sourceUi.dialog(page);
    await expectCropped(dialog);
    await expect(sourcePdfUi.fullDocument(dialog)).toHaveCount(0);
  },
);

test(
  'UX12-PDFPREVIEW-AC02 after submitting, 문제 원문 opens the PDF at the marked region with its neighbours, and solving again crops it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, unique('pdfpreview-ac02'));
    await page.setViewportSize(DESKTOP);
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openImported(page, s, s.single);
    await submitCorrect(panel, 1);
    const url = page.url();

    const button = sourceUi.button(panel);
    await button.click();
    const dialog = sourceUi.dialog(page);
    await expect(previewUi.mark(dialog)).toBeVisible();
    await expect(pdfPage(dialog, 1)).toBeVisible();
    await expect(sourcePdfUi.currentPage(dialog)).toHaveValue('1');
    await expectScrollsTo(dialog, 2);
    expect(page.url()).toBe(url);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(button).toBeFocused();
    await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();

    await panel.getByRole('button', { name: AGAIN }).click();
    await expect(panelUi.submit(panel)).toBeVisible();
    await button.click();
    await expectCropped(sourceUi.dialog(page));
  },
);

test(
  'UX12-PDFPREVIEW-AC03 관련 본문 and its excerpt open the PDF with the cited block marked and the panel unchanged',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member(unique('pdfpreview-ac03'));
    const ws = await workspaceFactory.create(owner);
    const relsrc = await seedRelsrcBook(owner, ws.id);
    await createSourcedQuestion(owner, ws.id, relsrc, {
      ...relsrcInput('pdfpreview-ac03', relsrc),
      question_number: 1,
    });
    await page.setViewportSize(DESKTOP);
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await panelUi.option(panel, ANSWER).check();
    await panelUi.submit(panel).click();
    await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
    const body = await expandRelated(panel);

    await relatedUi.open(relatedUi.row(body, 0)).click();
    const excerpt = relatedUi.excerptPanel(page);
    const inPdf = relatedUi.openInPdf(excerpt);
    await inPdf.click();
    const dialog = sourcePdfUi.dialog(page);
    await expect(previewUi.mark(dialog)).toBeVisible();
    await expect(sourcePdfUi.currentPage(dialog)).toHaveValue(String(ANSWER_PAGE));
    await expect(pdfPage(dialog, ANSWER_PAGE)).toBeVisible();
    await expectScrollsTo(dialog, ANSWER_PAGE + 1);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(excerpt).toBeVisible();
    await expect(inPdf).toBeFocused();
  },
);

test(
  'UX12-PDFPREVIEW-AC04 in a range run 문제 원문 stays cropped until the run ends, even on a submitted position',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, unique('pdfpreview-ac04'));
    await page.setViewportSize(DESKTOP);
    await openHome(page, s.owner, s.workspaceId);
    let run = await openRangePicker(page);
    await runUi.selectAll(run).check();
    await runUi.start(run).click();
    await expect(page).toHaveURL(/[?&]practice=[0-9a-f-]{36}(&|$)/);
    run = runUi.panel(page);
    await expect(sourceUi.button(run)).toBeVisible();

    await panelUi.option(run, correctText(1)).check();
    await panelUi.submit(run).click();
    await expect(run.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();

    // Submitted, with positions still to solve: their answers are in the same PDF.
    await sourceUi.button(run).click();
    await expectCropped(sourceUi.dialog(page));
    await page.keyboard.press('Escape');
    await expect(sourceUi.dialog(page)).toHaveCount(0);

    await goToResults(run);
    await runUi.resultRows(run).first().getByRole('button').first().click();
    await expect(sourceUi.button(run)).toBeVisible();
    await sourceUi.button(run).click();
    await expect(previewUi.mark(sourceUi.dialog(page))).toBeVisible();
  },
);

test(
  'UX12-PDFPREVIEW-AC05 an AI 질문 citation opens the PDF in place, and over an unsubmitted question it stays a link',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member(unique('pdfpreview-ac05'));
    const ws = await workspaceFactory.create(owner);
    await seedAskBook(owner, ws.id);
    const { conversation } = await askThroughApi(owner, ws.id, '가나다 원리를 설명해 줘');
    const question = await createQuestion(
      owner,
      ws.id,
      mcqInput('PDFPREVIEW 제출 전 문제', ['첫째 보기', '둘째 보기']),
    );
    await page.setViewportSize(DESKTOP);
    await signInAs(page, owner.user);

    await page.goto(askPath(ws.id, conversation));
    const panel = askUi.panel(page);
    const answer = askUi.answers(panel).last();
    await askUi.footnote(answer, 1).click();
    const excerpt = searchUi.excerptPanel(page);
    await expect(excerpt).toContainText(PASSAGES.book);
    const inPdf = searchUi.openInPdf(excerpt);
    const url = page.url();
    await inPdf.click();
    const dialog = sourcePdfUi.dialog(page);
    await expect(sourcePdfUi.currentPage(dialog)).toHaveValue('2');
    await expect(pdfPage(dialog, 2)).toBeVisible();
    expect(page.url()).toBe(url);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(inPdf).toBeFocused();

    // The panel over a question with its answer hidden: no PDF opens on top of that question.
    await page.goto(`${askPath(ws.id, conversation)}&question=${question.id}`);
    const over = askUi.panel(page);
    await askUi.footnote(askUi.answers(over).last(), 1).click();
    const guarded = searchUi.excerptPanel(page);
    await expect(guarded).toContainText(PASSAGES.book);
    await expect(guarded.getByRole('link', { name: /PDF에서 보기|view in pdf/i })).toBeVisible();
    await expect(guarded.getByRole('button', { name: /PDF에서 보기|view in pdf/i })).toHaveCount(0);
  },
);

test(
  'UX12-PDFPREVIEW-AC06 from 문제 상세 the dialog stacks above it and Escape closes only the dialog',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, unique('pdfpreview-ac06'));
    await page.setViewportSize(DESKTOP);
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openImported(page, s, s.single);
    await choosePanelMenu(page, panel, 'answers');
    const detail = detailUi.dialog(page);
    const button = sourceUi.button(detail);
    await button.click();
    const dialog = sourceUi.dialog(page);
    await expect(previewUi.mark(dialog)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(detail).toBeVisible();
    await expect(button).toBeFocused();
  },
);

test.describe('UX12-PDFPREVIEW-AC06 phone', () => {
  const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 14'];
  test.use(iphone);

  test(
    'UX12-PDFPREVIEW-AC06 on a phone the PDF is a full-screen sheet and Back closes only the sheet',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const s = await seedQuestionSource(workspaceFactory, unique('pdfpreview-ac06-phone'));
      await openHome(page, s.owner, s.workspaceId);
      const panel = await openImported(page, s, s.single);
      await submitCorrect(panel, 1);
      await sourceUi.button(panel).click();
      const dialog = sourceUi.dialog(page);
      await expect(previewUi.mark(dialog)).toBeVisible();
      expect((await dialog.boundingBox())?.width).toBe(page.viewportSize()?.width);
      const url = page.url();
      await page.goBack();
      await expect(dialog).toHaveCount(0);
      await expect(panel).toBeVisible();
      expect(page.url()).toBe(url);
    },
  );
});

async function openBook(
  page: Page,
  workspaceFactory: Parameters<typeof seedQuestionSource>[0],
  label: string,
): Promise<Locator> {
  const owner = await workspaceFactory.member(unique(label));
  const ws = await workspaceFactory.create(owner);
  const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
  await signInAs(page, owner.user);
  await page.goto(`/workspaces/${ws.id}/documents/${documentId}`);
  await expect(viewerUi.settingsBar(page)).toBeVisible();
  await expect(viewerUi.pane(page, 'pdf').getByRole('img').first()).toBeVisible();
  return viewerUi.settingsBar(page).locator('..');
}

const TOOLBAR = /^(PDF 보기 도구|pdf tools)$/i;
const SHOW_TOOLS = /^(보기 도구 표시|show view tools)$/i;
const IDLE_TIMEOUT = { timeout: 6000 };

test(
  'UX12-PDFPREVIEW-AC07 the PDF header is a glass surface the page blurs behind',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.setViewportSize(DESKTOP);
    const chrome = await openBook(page, workspaceFactory, 'pdfpreview-ac07');
    await expect(chrome.getByRole('toolbar', { name: TOOLBAR })).toBeVisible();
    const look = await chrome.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        blur: style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter'),
        color: style.backgroundColor,
      };
    });
    expect(look.blur).toContain('blur');
    expect(look.color, 'the page shows through').toMatch(/rgba\(|color\(.* \/ /);
  },
);

test(
  'UX12-PDFPREVIEW-AC08 moving to the top edge brings the hidden header back without moving the PDF',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.setViewportSize(DESKTOP);
    const chrome = await openBook(page, workspaceFactory, 'pdfpreview-ac08');
    const pdf = viewerUi.pane(page, 'pdf');
    const shown = await boxOf(pdf);
    await page.mouse.move(600, 400);
    await expect(chrome).toHaveAttribute('data-hidden', 'true', IDLE_TIMEOUT);
    expect(await boxOf(pdf)).toEqual(shown);
    await page.mouse.move(600, 8);
    await expect(chrome).not.toHaveAttribute('data-hidden');
    expect(await boxOf(pdf)).toEqual(shown);
  },
);

test.describe('UX12-PDFPREVIEW-AC09 touch', () => {
  test.use({ hasTouch: true });

  test(
    'UX12-PDFPREVIEW-AC09 tapping the page toggles the header and a scroll does not',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await page.setViewportSize({ width: 834, height: 1112 });
      const chrome = await openBook(page, workspaceFactory, 'pdfpreview-ac09');
      await expect(chrome).toHaveAttribute('data-hidden', 'true', IDLE_TIMEOUT);
      const pdf = await boxOf(viewerUi.pane(page, 'pdf'));
      const point = { x: pdf.x + pdf.width / 2, y: pdf.y + pdf.height / 2 };
      await page.touchscreen.tap(point.x, point.y);
      await expect(chrome).not.toHaveAttribute('data-hidden');
      await page.touchscreen.tap(point.x, point.y);
      await expect(chrome).toHaveAttribute('data-hidden', 'true');
    },
  );
});

test(
  'UX12-PDFPREVIEW-AC10 keyboard focus brings the hidden header back',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.setViewportSize(DESKTOP);
    const chrome = await openBook(page, workspaceFactory, 'pdfpreview-ac10');
    await page.mouse.move(600, 400);
    await expect(chrome).toHaveAttribute('data-hidden', 'true', IDLE_TIMEOUT);
    await page.getByRole('button', { name: SHOW_TOOLS }).focus();
    await expect(chrome).not.toHaveAttribute('data-hidden');
    await viewerUi.expandOutline(page).focus();
    await expect(chrome).not.toHaveAttribute('data-hidden');
  },
);

test(
  'UX12-PDFPREVIEW-AC11 with reduced motion the header appears and hides without a transition',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(DESKTOP);
    const chrome = await openBook(page, workspaceFactory, 'pdfpreview-ac11');
    const seconds = await chrome.evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    );
    expect(seconds.split(',').every((value) => Number.parseFloat(value) < 0.001)).toBe(true);
  },
);
