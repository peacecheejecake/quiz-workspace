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
  archiveQuestion,
  authUi,
  captchaUi,
  choosePanelMenu,
  detailUi,
  inactiveUi,
  createNumberedQuestions,
  createQuestion,
  dedupUi,
  mcqInput,
  docUi,
  documentsPath,
  editorUi,
  expect,
  formAlert,
  homePath,
  homeUi,
  QUESTION_MENU_REASONS,
  openSearchOptions,
  closeSearchOptions,
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
  openContentSearch,
  runSearch,
  searchPath,
  searchUi,
  setMyState,
  signInAs,
  snippet,
  test,
  uploadReadyBook,
  wsUi,
  answerCorrectly,
  chooseQuestionMenu,
  book,
  block,
  correctBlock,
  publishDocument,
  waitForJobStatus,
  chooseWorkspaceAction,
  ARCHIVE_ACTION,
  DELETE_ACTION,
  notFoundHeading,
  RESULT_TEXT,
  failingOnceCopy,
  INDEX_FAILURE_MARKER,
  main,
  questionPaper,
  uploadQuestionPaper,
  uniqueWorkspaceName,
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

    // Archived workspace: every screen is read-only (WS-01). Since UX3c the sections are the home
    // and its dialogs (UX7-BANK retired the 전체 문제 page).
    for (const path of [
      homePath(other.id),
      documentsPath(other.id),
      homePath(other.id, 'panel=history'),
      homePath(other.id, 'panel=share'),
    ]) {
      await page.goto(path);
      // A deep-linked dialog is modal (UX9, HOMEDLG-01): the visually hidden h1 behind it is
      // hidden from assistive technology meanwhile.
      await expect(page.getByRole('heading', { level: 1, includeHidden: true })).toHaveCount(1);
      await settle(page);
      await expectAccessible(page, `archived workspace ${path}`);
    }
    // The read-only 문제 menu: disabled items with the reason in text (UX7-DOCS-2).
    await page.goto(homePath(other.id));
    await homeUi.questionMenuButton(page).click();
    await expect(homeUi.questionMenu(page).getByText(QUESTION_MENU_REASONS.archived)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'archived workspace 문제 menu');
    await page.keyboard.press('Escape');

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

    await page.goto(documentsPath(ws.id));
    await expect(docUi.emptyState(page)).toBeVisible();
    await expectAccessible(page, 'documents empty');
    // The settings popovers of the 문제 search (filters, on the home) and the 본문 search (mode
    // tooltips, filters, on its own page since UX9 — SEARCH-02), UX7-SEARCH.
    await page.goto(homePath(ws.id));
    await openSearchOptions(page, 'questions');
    await expectAccessible(page, 'question search settings popover');
    await closeSearchOptions(page, 'questions');
    await page.goto(searchPath(ws.id));
    await openContentSearch(page);
    await expectAccessible(page, 'search without documents');
    await openSearchOptions(page, 'body');
    await expectAccessible(page, 'body search settings popover');
    await closeSearchOptions(page, 'body');

    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    await page.goto(documentsPath(ws.id));
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

    await page.goto(searchPath(ws.id));
    await runSearch(page, snippet(target.text, 10), 'keyword');
    await expect(searchUi.resultItems(page).first()).toBeVisible();
    await expectAccessible(page, 'search results');
    await searchUi.resultItems(page).first().getByRole('button').first().click();
    await expect(searchUi.excerptPanel(page)).toBeVisible();
    await expectAccessible(page, 'search excerpt panel');
    await page.goto(searchPath(ws.id));
    await runSearch(page, 'zqxjv-없는-검색어-0000', 'keyword');
    await expect(searchUi.emptyState(page)).toBeVisible();
    await expectAccessible(page, 'search no results');
    // SEARCH-01-AC06 degraded state: keyword results + the "dense unavailable" status notice
    // (APP_ENV=test query-embedding failure marker). Fresh page: a mode switch re-runs the last
    // search, and Enter does not submit while that request keeps the submit button busy.
    await page.goto(searchPath(ws.id));
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
  'A11Y-04 questions heatmap, preview, practice panel, its 문제 관리 menu and the question editor',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('a11y04');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);

    await page.goto(overviewPath(ws.id));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'questions overview empty');

    const questions = await createNumberedQuestions(owner, ws.id, 'a11y04', 12);
    const [first, second, third] = questions;
    if (!first || !second || !third) throw new Error('questions');
    await answerCorrectly(owner, first);
    await setMyState(owner, second.id, { is_favorite: true });
    await answerCorrectly(owner, third); // retry needs a correct last result (RETRY-01)
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
    // A wrong option by its text, not by position: the displayed order is shuffled per session,
    // so `.first()` scanned the correct or the incorrect graded state at random. Incorrect shows
    // both result tones (the chosen option and the correct one).
    await panelUi.option(panel, 'a11y04-4 보기 나').check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.incorrect);
    await expectAccessible(page, 'practice panel graded');
    // UX7-BANK: the editors' 문제 관리 menu and the 문제 편집 dialog over the panel.
    await panelUi.manage(panel).click();
    await expect(panelUi.manageItem(page, 'edit')).toBeVisible();
    await expectAccessible(page, 'practice panel 문제 관리 menu');
    await panelUi.manageItem(page, 'edit').click();
    const editForm = questionFormUi.form(page);
    await expect(questionFormUi.stem(editForm)).not.toHaveValue('');
    await expectAccessible(page, 'question edit form');
    await page.keyboard.press('Escape');
    await expect(editForm).toBeHidden();
    // UX7-BANK-2: the read-only 문제 상세 dialog (answers, sources, revisions) over the panel.
    await choosePanelMenu(page, panel, 'history');
    const detail = detailUi.dialog(page);
    await expect(detailUi.revisions(detail).first()).toBeVisible();
    await expectAccessible(page, 'question detail dialog');
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();
    await panelUi.close(panel).click();

    // UX7-BANK-2: the 보관·초안 문제 dialog, empty and with an archived question.
    await chooseQuestionMenu(page, 'inactive');
    const inactive = inactiveUi.dialog(page);
    await expect(inactive.getByRole('heading', { name: /없습니다|no /i })).toBeVisible();
    await expectAccessible(page, 'archived and draft questions empty');
    await archiveQuestion(owner, questions[11] ?? first);
    await page.reload();
    await expect(inactiveUi.rows(inactive)).toHaveCount(1);
    await expectAccessible(page, 'archived and draft questions populated');
    await inactiveUi.close(inactive).click();

    // The 문제 등록 dialog on the home (문제 › 직접 추가, UX7-BANK).
    await chooseQuestionMenu(page, 'create');
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

test('A11Y-05 question import review', { tag: '@infra' }, async ({ page, workspaceFactory }) => {
  const owner = await workspaceFactory.member('a11y05');
  const ws = await workspaceFactory.create(owner);
  await signInAs(page, owner.user);

  await page.goto(importPath(ws.id));
  await expect(importUi.openDocuments(main(page))).toBeVisible();
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

  // Error state: the first import job of a marked paper fails (fake extractor, QIMPORT A7).
  const failingWs = await workspaceFactory.create(owner);
  mkdirSync(test.info().outputDir, { recursive: true });
  await uploadQuestionPaper(
    page,
    failingWs.id,
    failingOnceCopy(questionPaper(), test.info().outputDir),
  );
  await expect(importUi.alert(page)).toContainText(/실패|오류|failed|error/i, {
    timeout: JOB_TIMEOUT_MS,
  });
  await settle(page);
  await expectAccessible(page, 'import failed with retry');
});

test(
  'A11Y-13 중복 문제 정리 dialog: groups with the answers warning, the confirm step, a stopped merge with the frozen plan, and the empty state',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    // UX7-DEDUP (QOV-01-AC16): two copies of one MCQ (other option order and labels) whose answers
    // differ, so the group shows its 정답이 서로 다릅니다 warning. Deterministic: no attempts, the
    // oldest is the default keep.
    const owner = await workspaceFactory.member('a11y13');
    const ws = await workspaceFactory.create(owner);
    const stem = 'a11y13 다음 중 물의 순환에 대한 설명으로 옳은 것은?';
    const texts = ['증발은 액체가 기체로 변한다', '응결은 기체가 고체로 변한다', '강수는 없다'];
    await createQuestion(owner, ws.id, { ...mcqInput(stem, texts, 0), question_number: 1 });
    const copy = await createQuestion(owner, ws.id, {
      ...mcqInput(
        `${stem.replace(/ /g, '  ')} ( )`,
        [`③ ${texts[2]}`, `① ${texts[0]}`, `② ${texts[1]}`],
        0,
      ),
      question_number: 2,
    });
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(2);

    await chooseQuestionMenu(page, 'duplicates');
    const dialog = dedupUi.dialog(page);
    const group = dedupUi.groups(dialog).first();
    await expect(dedupUi.keep(group)).toHaveCount(2);
    await expect(dedupUi.warning(group)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'duplicates dialog with a group');

    await dedupUi.merge(dialog).click();
    const confirm = dedupUi.confirm(page);
    await expect(confirm).toBeVisible();
    await expectAccessible(page, 'duplicates confirm');
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();

    // The copy is archived elsewhere meanwhile: the merge is refused, the plan is frozen.
    await archiveQuestion(owner, copy);
    await dedupUi.merge(dialog).click();
    await dedupUi.confirmButton(dedupUi.confirm(page)).click();
    const stopped = dialog.getByRole('alert');
    await expect(stopped).toBeVisible();
    await expect(dedupUi.include(group)).toBeDisabled();
    await expect(dedupUi.include(group)).toHaveAccessibleDescription(
      /이어서 정리하거나 다시 검사한 뒤 바꿀 수 있습니다/,
    );
    await expectAccessible(page, 'duplicates merge stopped, plan frozen');

    await stopped.getByRole('button', { name: /^(다시 검사|scan again)$/i }).click();
    await expect(dedupUi.empty(dialog)).toBeVisible();
    await expectAccessible(page, 'duplicates empty');
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
    await expect(historyUi.dialog(page)).toBeVisible();
    // A fresh workspace: only its creation is listed.
    await expect(historyUi.ofKind(page, 'activity')).toHaveCount(1);
    await settle(page);
    await expectAccessible(page, 'history of a new workspace');

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

    // One chronological list (UX3c) holding all three kinds.
    await page.goto(historyPath(ws.id));
    for (const kind of ['activity', 'job', 'attempt'] as const) {
      await expect(historyUi.ofKind(page, kind).first()).toBeVisible();
    }
    await settle(page);
    await expectAccessible(page, 'history list');
    // A second dialog stacked on top of it: UX9 (HOMEDLG-01) a deep link opens both, modal, the
    // last one on top.
    await page.goto(homePath(ws.id, 'panel=history&panel=documents'));
    await expect(homeUi.documentsDialog(page)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'history and documents dialogs');
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

// UX7-CSS: under reduced motion nothing transitions at all — not even for one frame — so a
// token-coloured element shows its new computed style at once, and overlays whose exit relied on
// a (collapsed) animation still close and unmount.
const REDUCED_CLOSE_MS = 1_000;

test(
  'A11Y-10 reduced motion: a style change applies in the same frame; dialogs, menus, toasts and panels still close',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('a11y10rm');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('a11y10rm'));
    await signInAs(page, owner.user);
    await page.goto('/workspaces');
    const create = wsUi.createButton(page);
    await expect(create).toBeEnabled();

    // Theme switch: the body (declares no transition) and a kit button (declares one) read the
    // new token colours synchronously, and the change starts no CSS transition.
    await settle(page);
    // Retried only in case a late render resets the attribute mid-sample (`kept` false).
    await expect(async () => {
      const sample = await create.evaluate(async (button) => {
        const read = () => {
          const body = getComputedStyle(document.body);
          const own = getComputedStyle(button);
          return [body.backgroundColor, body.color, own.backgroundColor, own.color];
        };
        const root = document.documentElement;
        const from = root.getAttribute('data-theme');
        const before = read();
        const target = from === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', target);
        const now = read();
        const transitions = document
          .getAnimations()
          .filter((a) => a instanceof CSSTransition)
          .map((a) => (a as CSSTransition).transitionProperty);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const settled = read();
        const kept = root.getAttribute('data-theme') === target;
        if (from === null) root.removeAttribute('data-theme');
        else root.setAttribute('data-theme', from);
        return { before, now, settled, transitions, kept };
      });
      expect(sample.kept, 'data-theme kept while sampling').toBe(true);
      expect(sample.settled, 'the theme switch changes the token colours').not.toEqual(
        sample.before,
      );
      expect(sample.now, 'computed style in the same frame').toEqual(sample.settled);
      expect(sample.transitions, 'CSS transitions started by the switch').toEqual([]);
    }).toPass({ timeout: 10_000 });

    // Modal dialog closes and a toast appears; its close button removes it.
    const name = uniqueWorkspaceName('a11y10rm-new');
    await create.click();
    const dialog = wsUi.createDialog(page);
    await wsUi.nameField(dialog).fill(name);
    await wsUi.submitCreate(dialog).click();
    await expect(dialog).toHaveCount(0, { timeout: REDUCED_CLOSE_MS });
    const toast = page
      .getByRole('region', { name: /알림|notifications/i })
      .getByRole('listitem')
      .filter({ hasText: name });
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: /^(닫기|close)$/i }).click();
    await expect(toast).toHaveCount(0, { timeout: REDUCED_CLOSE_MS });

    // Dropdown menu closes on Escape.
    await wsUi.moreButton(wsUi.item(wsUi.tabPanel(page), ws.name)).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0, { timeout: REDUCED_CLOSE_MS });

    // FloatingSidePanel (modal since UX9, HOMEDLG-01) unmounts from its close button.
    await page.goto(homePath(ws.id));
    await homeUi.documentsButton(page).click();
    const panel = homeUi.documentsDialog(page);
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: /문서 관리 닫기|close/i }).click();
    await expect(panel).toHaveCount(0, { timeout: REDUCED_CLOSE_MS });
  },
);
