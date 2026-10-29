// M7.2 visual baselines (docs/e2e-strategy.md §4/§7): key screens in light and dark, on the
// `visual-desktop` (1280×800) and `visual-ipad` (834×1194 portrait, touch) projects.
//
// Determinism: the browser runs in the pinned Playwright container (same fonts and rasterizer on
// macOS and CI, see tests/e2e/README.md "Visual baselines"); locale ko-KR, Asia/Seoul, reduced
// motion, animations disabled, caret hidden, web fonts awaited. Data is per-test but its visible
// text is fixed (workspace names, question labels, synthetic PDFs); what still varies (dates and
// times, ids) is masked. Share secrets never appear in a screenshot: the shared view is captured
// after the fragment exchange, the owner's one-time link field is not captured.
import type { Locator, Page } from '@playwright/test';
import { COLOR_SCHEMES } from '../fixtures/a11y.ts';
import {
  answerCorrectly,
  authUi,
  bankPath,
  createNumberedQuestions,
  docUi,
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
  bankUi,
  block,
  book,
  createQuestion,
  homeUi,
  listDocuments,
  outlineNodeId,
} from '../fixtures/test.ts';
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
import {
  startSummary,
  summaryPanelPath,
  summaryUi,
  waitForSummaryRun,
} from '../fixtures/summary.ts';

test.use(NO_VISUAL_ARTIFACTS);
test.describe.configure({ timeout: JOB_TIMEOUT_MS + 90_000 });

const BOOK = book('book-ko');

/** Dynamic regions: timestamps (server dates, relative times) and the per-test user's email in
 *  the header account button (UX1). */
function dynamic(page: Page): Locator[] {
  return [page.locator('time'), page.locator('[data-visual-dynamic]'), authUi.accountButton(page)];
}

async function ready(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Full-page screenshot of the current state in every color scheme: `<name>-<scheme>.png`. */
async function snap(page: Page, name: string, extraMask: Locator[] = []): Promise<void> {
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
  'VISUAL-03 questions heatmap (statuses, favorite star, retry), practice panel and bank',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('visual03');
    const ws = await workspaceFactory.create(owner, '문제 풀이');
    const qs = await createNumberedQuestions(owner, ws.id, 'visual', 24);
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
    // UX6: the unified search's 본문 settings popover over the home.
    await openSearchOptions(page, 'body');
    await page.mouse.move(0, 0);
    await snap(page, 'search-options');
    await page.keyboard.press('Escape');

    await overviewUi.dot(page, 3).click();
    const panel = panelUi.numbered(page, 3);
    await expect(panel).toBeVisible();
    await snap(page, 'practice-panel');
    await panelUi.close(panel).click();
    await expect(panel).toHaveCount(0);

    await page.goto(bankPath(ws.id));
    await expect(bankUi.items(page).first()).toBeVisible();
    await snap(page, 'question-bank');
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

    await page.goto(`/workspaces/${ws.id}/documents/${documentId}`);
    await expect(editorUi.textPanel(page)).toBeVisible();
    await expect(editorUi.viewer(page).locator('canvas').first()).toBeVisible();
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
