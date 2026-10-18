// M7.2 accessibility: axe (WCAG 2.2 A/AA + best practices, light and dark) on every implemented
// screen in its main states — empty, populated, dialogs/panels open, error states. Share/fork
// screens (secrets on screen) are in a11y-share.spec.ts. Rules and exclusions: fixtures/a11y.ts.
//
// Each test signs in its own user and builds its data through the public API (per-test users and
// workspaces, AGENTS.md §5). Locators reuse the screen specs' UI contract helpers.
import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expectAccessible } from '../fixtures/a11y.ts';
import {
  authUi,
  captchaUi,
  bankUi,
  createNumberedQuestions,
  createQuestion,
  docUi,
  editorUi,
  expect,
  formAlert,
  generatePath,
  generateUi,
  generationSourceInput,
  historyPath,
  historyUi,
  importPath,
  importPaperDrafts,
  importUi,
  JOB_TIMEOUT_MS,
  overviewPath,
  overviewUi,
  panelUi,
  questionFormUi,
  runSearch,
  searchUi,
  setMyState,
  signInAs,
  snippet,
  test,
  uploadReadyBook,
  wsUi,
  answerCorrectly,
  book,
  block,
  correctBlock,
  publishDocument,
  waitForJobStatus,
  chooseWorkspaceAction,
  ARCHIVE_ACTION,
  DELETE_ACTION,
  bankPath,
  notFoundHeading,
  RESULT_TEXT,
  failingOnceCopy,
  INDEX_FAILURE_MARKER,
  main,
  questionPaper,
  uploadQuestionPaper,
} from '../fixtures/test.ts';

test.describe.configure({ timeout: 2 * JOB_TIMEOUT_MS + 60_000 });

const BOOK = book('book-ko');

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

test('A11Y-01 public auth screens and their error states', async ({ page, turnstile }) => {
  // Security check (A4) states: interactive challenge pending, then the script unavailable.
  turnstile.mode = 'interactive';
  await page.goto('/signup');
  await expect(captchaUi.group(page)).toBeVisible();
  await expectAccessible(page, 'signup security check pending');
  turnstile.mode = 'unreachable';
  await page.goto('/login');
  await expect(captchaUi.retry(page)).toBeVisible();
  await expectAccessible(page, 'login security check unavailable');
  turnstile.mode = 'pass';

  await page.goto('/login');
  await expect(authUi.email(page)).toBeVisible();
  await expectAccessible(page, 'login');
  await authUi.signInButton(page).click();
  await expect(page.locator('[aria-invalid="true"]').first()).toBeVisible();
  await expectAccessible(page, 'login with field errors');
  await authUi.email(page).fill('nobody@example.test');
  await authUi.password(page).fill('wrong-password-123');
  await authUi.signInButton(page).click();
  await expect(formAlert(page)).toBeVisible();
  await expectAccessible(page, 'login failed');

  await page.goto('/signup');
  await expect(authUi.email(page)).toBeVisible();
  await expectAccessible(page, 'signup');
  await authUi.signUpButton(page).click();
  await expect(page.locator('[aria-invalid="true"]').first()).toBeVisible();
  await expectAccessible(page, 'signup with field errors');

  for (const path of ['/forgot-password', '/reset-password', '/auth/verify', '/auth/error']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page, path);
  }
  for (const path of ['/terms', '/privacy']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page, path);
  }
});

test(
  'A11Y-02 account security, workspace home (empty, populated, dialogs) and the 404 page',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const member = await workspaceFactory.member('a11y02');
    await signInAs(page, member.user);
    await expect(wsUi.emptyState(page)).toBeVisible();
    await expectAccessible(page, 'workspaces empty');

    await wsUi.createButton(page).click();
    const dialog = wsUi.createDialog(page);
    await expect(dialog).toBeVisible();
    await expectAccessible(page, 'create workspace dialog');
    await wsUi.submitCreate(dialog).click();
    await expect(dialog.locator('[aria-invalid="true"]').first()).toBeVisible();
    await expectAccessible(page, 'create workspace dialog with error');
    await page.keyboard.press('Escape');

    const ws = await workspaceFactory.create(member);
    const other = await workspaceFactory.create(member);
    await workspaceFactory.archive(member, other.id);
    await page.reload();
    const item = wsUi.item(wsUi.tabPanel(page), ws.name);
    await expect(item).toBeVisible();
    await expectAccessible(page, 'workspaces populated');
    await wsUi.moreButton(item).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expectAccessible(page, 'workspace actions menu');
    await page.keyboard.press('Escape');
    await chooseWorkspaceAction(page, item, DELETE_ACTION);
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expectAccessible(page, 'delete confirmation');
    await page.keyboard.press('Escape');
    await chooseWorkspaceAction(page, item, ARCHIVE_ACTION);
    if (await page.getByRole('alertdialog').count()) {
      await expectAccessible(page, 'archive confirmation');
      await page.keyboard.press('Escape');
    }
    await wsUi.archivedTab(page).click();
    await expect(wsUi.item(wsUi.tabPanel(page), other.name)).toBeVisible();
    await expectAccessible(page, 'archived tab');

    await page.goto('/settings/security');
    await expect(authUi.newPassword(page)).toBeVisible();
    await expectAccessible(page, 'account security');
    await authUi.updatePasswordButton(page).click();
    await expect(page.locator('[aria-invalid="true"]').first()).toBeVisible();
    await expectAccessible(page, 'account security with field errors');

    // Archived workspace: every screen is read-only (WS-01, QBANK-01 read-only notice).
    for (const path of ['documents', 'questions', 'questions/bank', 'search', 'history']) {
      await page.goto(`/workspaces/${other.id}/${path}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await settle(page);
      await expectAccessible(page, `archived workspace ${path}`);
    }

    const res = await page.goto('/workspaces/00000000-0000-4000-8000-000000000000/documents');
    expect(res?.status()).toBe(404);
    await expect(notFoundHeading(page)).toBeVisible();
    await expectAccessible(page, 'not found');
  },
);

test(
  'A11Y-03 documents library, PDF editor and search (empty, populated, panels, errors)',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('a11y03');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);

    await page.goto(`/workspaces/${ws.id}/documents`);
    await expect(docUi.emptyState(page)).toBeVisible();
    await expectAccessible(page, 'documents empty');
    await page.goto(`/workspaces/${ws.id}/search`);
    await expect(searchUi.box(page)).toBeVisible();
    await expectAccessible(page, 'search without documents');

    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    await page.goto(`/workspaces/${ws.id}/documents`);
    await expect(docUi.ready(docUi.item(page, /book-ko|물의 순환과 정수 처리/))).toBeVisible();
    await expectAccessible(page, 'documents populated');
    // Client-side rejection of an unsupported file (error state).
    const chooser = page.waitForEvent('filechooser');
    await docUi.uploadButton(page).click();
    await (
      await chooser
    ).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
    await expect(docUi.alert(page).first()).toBeVisible();
    await expectAccessible(page, 'documents upload rejected');

    await page.goto(`/workspaces/${ws.id}/documents/${documentId}`);
    await expect(editorUi.outline(page)).toBeVisible();
    await expect(editorUi.textPanel(page)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'document editor');
    const target = block(BOOK, 'ch1-s2-p1');
    const article = editorUi.block(page, snippet(target.text));
    await editorUi.editButton(article).click();
    await expect(editorUi.blockTextbox(page)).toBeVisible();
    await expectAccessible(page, 'document editor editing a block');

    await page.goto(`/workspaces/${ws.id}/search`);
    await runSearch(page, snippet(target.text, 10), 'keyword');
    await expect(searchUi.resultItems(page).first()).toBeVisible();
    await expectAccessible(page, 'search results');
    await searchUi.resultItems(page).first().getByRole('button').first().click();
    await expect(searchUi.excerptPanel(page)).toBeVisible();
    await expectAccessible(page, 'search excerpt panel');
    await page.goto(`/workspaces/${ws.id}/search`);
    await runSearch(page, 'zqxjv-없는-검색어-0000', 'keyword');
    await expect(searchUi.emptyState(page)).toBeVisible();
    await expectAccessible(page, 'search no results');
    // SEARCH-01-AC06 degraded state: keyword results + the "dense unavailable" status notice
    // (APP_ENV=test query-embedding failure marker). Fresh page: a mode switch re-runs the last
    // search, and Enter does not submit while that request keeps the submit button busy.
    await page.goto(`/workspaces/${ws.id}/search`);
    await runSearch(page, `${snippet(target.text, 10)} E2E-FAIL-EMBEDDING`, 'hybrid');
    await expect(searchUi.resultItems(page).first()).toBeVisible();
    await expect(
      page
        .getByRole('main')
        .getByRole('status')
        .filter({ hasText: /의미 검색을 일시적으로/ }),
    ).toBeVisible();
    await expectAccessible(page, 'search degraded to keyword results');
  },
);

test(
  'A11Y-04 questions heatmap, preview, practice panel and the question bank',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('a11y04');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);

    await page.goto(overviewPath(ws.id));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'questions overview empty');
    await page.goto(bankPath(ws.id));
    await expect(bankUi.emptyState(page)).toBeVisible();
    await expectAccessible(page, 'question bank empty');

    const questions = await createNumberedQuestions(owner, ws.id, 'a11y04', 12);
    const [first, second, third] = questions;
    if (!first || !second || !third) throw new Error('questions');
    await answerCorrectly(owner, first);
    await setMyState(owner, second.id, { is_favorite: true });
    await setMyState(owner, third.id, { needs_retry: true });

    await page.goto(overviewPath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(12);
    await expectAccessible(page, 'questions overview populated');
    await overviewUi.dot(page, 2).focus();
    await expect(overviewUi.tooltip(page)).toBeVisible();
    await expectAccessible(page, 'heatmap preview on focus');

    await overviewUi.dot(page, 4).click();
    const panel = panelUi.numbered(page, 4);
    await expect(panel).toBeVisible();
    await expectAccessible(page, 'practice panel');
    await panelUi.options(panel).first().check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(
      new RegExp(`${RESULT_TEXT.correct.source}|${RESULT_TEXT.incorrect.source}`, 'i'),
    );
    await expectAccessible(page, 'practice panel graded');
    await panelUi.close(panel).click();

    await page.goto(bankPath(ws.id));
    await expect(bankUi.items(page).first()).toBeVisible();
    await expectAccessible(page, 'question bank populated');
    await bankUi.createButton(page).click();
    const form = questionFormUi.form(page);
    await expect(form).toBeVisible();
    await expectAccessible(page, 'question form');
    await questionFormUi.save(form).click();
    await expect(
      form.locator('[aria-invalid="true"]').or(questionFormUi.alert(form)).first(),
    ).toBeVisible();
    await expectAccessible(page, 'question form with errors');
  },
);

test(
  'A11Y-05 question import and variant generation review',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('a11y05');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);

    await page.goto(importPath(ws.id));
    await expect(importUi.uploadButton(page)).toBeVisible();
    await expectAccessible(page, 'import empty');
    await importPaperDrafts(owner, ws.id);
    await page.reload();
    await expect(importUi.draftItems(page).first()).toBeVisible({ timeout: JOB_TIMEOUT_MS });
    await settle(page);
    await expectAccessible(page, 'import drafts review');
    const compare = importUi.compare(importUi.draftItems(page).first());
    if (await compare.count()) {
      await compare.first().click();
      await expect(importUi.sourceView(page).first()).toBeVisible();
      await expectAccessible(page, 'import source comparison');
    }

    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const source = await createQuestion(
      owner,
      ws.id,
      generationSourceInput('disinfection', documentId, 20),
    );
    await page.goto(generatePath(ws.id, source.id));
    await expect(generateUi.source(page)).toBeVisible();
    await expectAccessible(page, 'generate form');
    await generateUi.generate(page).click();
    await expect(
      generateUi.alert(page).or(main(page).locator('[aria-invalid="true"]')).first(),
    ).toBeVisible();
    await expectAccessible(page, 'generate form without a variation');
    await generateUi.variation(page, 'PARAPHRASE').check();
    await generateUi.generate(page).click();
    await expect(generateUi.draftItems(page)).toHaveCount(1, { timeout: JOB_TIMEOUT_MS });
    await settle(page);
    await expectAccessible(page, 'generated draft review');

    // Error state: the first import job of a marked paper fails (fake extractor, QIMPORT A7).
    const failingWs = await workspaceFactory.create(owner);
    mkdirSync(test.info().outputDir, { recursive: true });
    await page.goto(importPath(failingWs.id));
    await uploadQuestionPaper(page, failingOnceCopy(questionPaper(), test.info().outputDir));
    await expect(importUi.alert(page)).toContainText(/실패|오류|failed|error/i, {
      timeout: JOB_TIMEOUT_MS,
    });
    await settle(page);
    await expectAccessible(page, 'import failed with retry');
  },
);

test(
  'A11Y-06 history with activity, failed job and attempts',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('a11y06');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(historyPath(ws.id));
    await expect(historyUi.heading(page)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'history empty');

    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const target = block(BOOK, 'ch1-s2-p1');
    await correctBlock(owner, documentId, 2, snippet(target.text, 12), `${target.text} 교정`);
    await waitForJobStatus(owner, await publishDocument(owner, documentId), 'succeeded');
    const [q] = await createNumberedQuestions(owner, ws.id, 'a11y06', 1);
    if (q) await answerCorrectly(owner, q);
    // A failed reindex (fake embedder marker, DOC-02-AC04): editor error state + failed job.
    await correctBlock(owner, documentId, 4, '염소와 같은 소독제', `${INDEX_FAILURE_MARKER} 교정`);
    await waitForJobStatus(owner, await publishDocument(owner, documentId), 'failed');
    await page.goto(`/workspaces/${ws.id}/documents/${documentId}`);
    await expect(editorUi.retryIndexButton(page)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'document editor after a failed reindex');

    for (const tab of [
      /^(변경 이력|활동|activity|changes)/i,
      /^(작업|작업 로그|jobs?)(?!\p{L})/iu,
      /^(풀이 이력|내 풀이|attempts|practice history)/i,
    ]) {
      await page.goto(historyPath(ws.id));
      await historyUi.open(page, tab);
      await settle(page);
      await expectAccessible(page, `history ${tab.source}`);
    }
  },
);

test(
  'A11Y-10 reduced motion and forced colors: no running motion, visible focus, shapes kept',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('a11y10');
    const ws = await workspaceFactory.create(owner);
    const [first, second] = await createNumberedQuestions(owner, ws.id, 'a11y10', 4);
    if (!first || !second) throw new Error('questions');
    await setMyState(owner, second.id, { is_favorite: true });
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(4);

    // Reduced motion is pinned for every project: opening a panel runs no animation/transition.
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await expect(panel).toBeVisible();
    const moving = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => a.playState === 'running')
        .map((a) => Number(a.effect?.getComputedTiming().duration ?? 0))
        .filter((ms) => ms > 1),
    );
    expect(moving, 'running animations under prefers-reduced-motion').toEqual([]);
    await panelUi.close(panel).click();
    await expect(panel).toHaveCount(0);

    // Forced colors (Windows high contrast): focus stays visible, favorite keeps its star shape.
    await page.emulateMedia({ forcedColors: 'active' });
    const dot = overviewUi.dot(page, 2);
    await page.keyboard.press('ArrowRight');
    await expect(dot).toBeFocused();
    const outline = await dot.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(2);
    await expect(overviewUi.marker(dot)).toHaveAttribute('data-shape', 'star');
    await expectAccessible(page, 'heatmap in forced colors', { schemes: ['light'] });
    await page.emulateMedia({ forcedColors: 'none' });
  },
);
