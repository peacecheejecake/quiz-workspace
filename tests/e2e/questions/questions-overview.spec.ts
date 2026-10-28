// QOV-01 — Questions Heatmap 홈 (`/workspaces/:workspaceId/questions`),
// docs/screens/questions-overview.md; rules docs/questions.md §2–§3, §7–§8,
// docs/design-system.md §5–§6, docs/e2e-strategy.md §6.
//
// Each test signs in its own owner and works in its own workspace. Questions are created through
// the public question API with explicit numbers (A9) and study state is prepared through the
// public practice/my-state API (A10); every endpoint and label assumption is in the header of
// fixtures/questions.ts (A8–A13 for M5). Markers are found with `data-testid="question-marker"`
// (the one place the spec allows a test id) and read through `data-shape` / `data-status`.
// Migrated from the pre-harness starter tests/e2e/_pending/questions/overview.spec.ts.
import type { Locator, Page } from '@playwright/test';
import {
  answerCorrectly,
  chooseQuestionMenu,
  createNumberedQuestions,
  draftFor,
  expect,
  getOverview,
  homeUi,
  importPaperDrafts,
  JOB_TIMEOUT_MS,
  listAttempts,
  main,
  overviewItem,
  overviewPath,
  overviewUi,
  panelUi,
  publishDrafts,
  questionFormUi,
  questionPaper,
  scaleOf,
  searchUi,
  seedMembership,
  setMyState,
  signInAs,
  startPractice,
  statusColor,
  test,
  truthQuestion,
  uploadPdf,
  uploadReadyBook,
  waitForJob,
  type E2EFixtures,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const HOVER_SCALE = 1.18;

interface Seeded {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly questions: Question[];
}

async function seed(
  workspaceFactory: E2EFixtures['workspaceFactory'],
  label: string,
  count: number,
): Promise<Seeded> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const questions = await createNumberedQuestions(owner, ws.id, label, count);
  return { owner, workspaceId: ws.id, questions };
}

async function openOverview(page: Page, s: Seeded): Promise<void> {
  await signInAs(page, s.owner.user);
  await page.goto(overviewPath(s.workspaceId));
  await expect(overviewUi.heatmap(page)).toBeVisible();
}

function q(s: Seeded, n: number): Question {
  const found = s.questions[n - 1];
  if (!found) throw new Error(`no question ${n}`);
  return found;
}

async function box(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox();
  expect(b, 'element is laid out').not.toBeNull();
  return b as { x: number; y: number; width: number; height: number };
}

/** Removes hover and focus so markers are measured at rest. */
async function rest(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test(
  'QOV-01-AC01 100 confirmed questions and import drafts render exactly 100 markers; shuffled practice adds none',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(2 * JOB_TIMEOUT_MS + 120_000);
    const s = await seed(workspaceFactory, 'qov01-ac01', 100);
    // A13: the question paper's 8 drafts stay in review (not CONFIRMED), so no markers.
    const { run, drafts } = await importPaperDrafts(s.owner, s.workspaceId);
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((d) => d.published_question_id === null)).toBe(true);

    const overview = await getOverview(s.owner, s.workspaceId);
    expect(overview.items).toHaveLength(100);
    expect(new Set(overview.items.map((i) => i.question_id))).toEqual(
      new Set(s.questions.map((x) => x.id)),
    );
    expect(overview.counts.total).toBe(100);

    await openOverview(page, s);
    await expect(overviewUi.markers(page)).toHaveCount(100);
    await expect(overviewUi.dots(page)).toHaveCount(100);
    await expect(overviewUi.inFilter(page)).toHaveCount(0); // no count line since UX4

    // Option shuffles (practice sessions, questions.md §5 OPTION_SHUFFLE) never create a dot.
    for (let i = 0; i < 5; i += 1) await startPractice(s.owner, q(s, 1).id);
    await page.reload();
    await expect(overviewUi.markers(page)).toHaveCount(100);
    expect((await getOverview(s.owner, s.workspaceId)).items).toHaveLength(100);

    // Approving 3 drafts adds exactly 3 markers (questions.md §8).
    const paper = questionPaper();
    const approved = [1, 4, 5].map((n) => draftFor(drafts, truthQuestion(paper, n)).id);
    await publishDrafts(s.owner, run.id, approved);
    await page.reload();
    await expect(overviewUi.markers(page)).toHaveCount(103);
    expect((await getOverview(s.owner, s.workspaceId)).counts.total).toBe(103);
  },
);

test(
  'QOV-01-AC02 hovering or focusing a marker shows the preview but never marks it viewed',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'qov01-ac02', 3);
    await openOverview(page, s);
    const dot = overviewUi.dot(page, 2);
    await expect(dot).toHaveAttribute('data-status', 'unseen');

    for (let i = 0; i < 10; i += 1) {
      await dot.hover();
      await expect(overviewUi.tooltip(page)).toBeVisible();
      await page.mouse.move(0, 0);
    }
    await dot.hover();
    await expect(overviewUi.tooltip(page)).toContainText(q(s, 2).revision.stem);
    await expect(overviewUi.tooltip(page)).toContainText(/미열람|아직 보지 않음|unseen/i);
    // Keyboard focus shows the same preview without recording a view either.
    await overviewUi.dot(page, 1).focus();
    await page.keyboard.press('ArrowRight');
    await expect(dot).toBeFocused();
    await expect(overviewUi.tooltip(page)).toBeVisible();

    await page.reload();
    await expect(overviewUi.dot(page, 2)).toHaveAttribute('data-status', 'unseen');
    await expect(overviewUi.marker(overviewUi.dot(page, 2))).toHaveAttribute(
      'data-status',
      'unseen',
    );
    expect((await overviewItem(s.owner, s.workspaceId, q(s, 2).id)).status).toBe('unseen');

    // Positive control: actually opening the practice panel records the view.
    await overviewUi.dot(page, 2).click();
    await expect(panelUi.numbered(page, 2)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(overviewUi.dot(page, 2)).toHaveAttribute('data-status', 'viewed');
    expect((await overviewItem(s.owner, s.workspaceId, q(s, 2).id)).status).toBe('viewed');
  },
);

test(
  'QOV-01-AC03 favorite swaps the rounded square for a rounded star with the same color, size and cell',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'qov01-ac03', 3);
    await answerCorrectly(s.owner, q(s, 2)); // a non-default status color
    await openOverview(page, s);
    const dot = overviewUi.dot(page, 2);
    const marker = overviewUi.marker(dot);
    const neighbour = overviewUi.dot(page, 3);
    await expect(dot).toHaveAttribute('data-status', 'correct');
    await expect(marker).toHaveAttribute('data-shape', 'square');
    await expect(dot).not.toHaveAttribute('aria-label', /즐겨찾기/);
    const correct = await statusColor(page, 'correct');
    await expect(marker).toHaveCSS('color', correct);
    const before = { cell: await box(dot), marker: await box(marker), next: await box(neighbour) };

    await dot.click();
    const panel = panelUi.numbered(page, 2);
    await expect(panel).toBeVisible();
    await panelUi.favoriteOn(panel).click();
    await expect(panelUi.favoriteOff(panel)).toBeVisible();
    await panelUi.close(panel).click();
    await expect(panel).toBeHidden();

    await expect(marker).toHaveAttribute('data-shape', 'star');
    await expect(marker).toHaveAttribute('data-status', 'correct');
    await expect(marker).toHaveCSS('color', correct);
    await expect(dot).toHaveAttribute('aria-label', /즐겨찾기/);
    await rest(page);
    const after = { cell: await box(dot), marker: await box(marker), next: await box(neighbour) };
    expect(after.cell).toEqual(before.cell);
    expect(after.next).toEqual(before.next);
    expect(after.marker.width).toBeCloseTo(before.marker.width, 1);
    expect(after.marker.height).toBeCloseTo(before.marker.height, 1);
    // Dense grid (UX5-UI): the drawn shapes are at most 1/3 of their width apart.
    const [a, b] = await Promise.all(
      [1, 2].map((n) =>
        overviewUi.marker(overviewUi.dot(page, n)).locator('rect, path').boundingBox(),
      ),
    );
    expect(a && b && b.x - (a.x + a.width) <= a.width / 3).toBe(true);

    const item = await overviewItem(s.owner, s.workspaceId, q(s, 2).id);
    expect(item).toMatchObject({ is_favorite: true, status: 'correct' });
    await page.reload();
    await expect(overviewUi.marker(overviewUi.dot(page, 2))).toHaveAttribute('data-shape', 'star');
  },
);

test(
  'QOV-01-AC04 hover and keyboard focus scale only the marker 1.18x with a preview and no grid shift',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'qov01-ac04', 3);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openOverview(page, s);
    const dot = overviewUi.dot(page, 2);
    const marker = overviewUi.marker(dot);
    const neighbour = overviewUi.dot(page, 3);
    await rest(page);
    expect(await scaleOf(marker)).toBe(1);
    const transition = await marker.evaluate((el) => {
      const style = getComputedStyle(el);
      return { property: style.transitionProperty, duration: style.transitionDuration };
    });
    expect(transition.property).toMatch(/transform|all/);
    expect(transition.duration).not.toMatch(/^0s(, 0s)*$/);
    const before = { cell: await box(dot), next: await box(neighbour) };

    await dot.hover();
    await expect.poll(() => scaleOf(marker)).toBeCloseTo(HOVER_SCALE, 2);
    await expect(overviewUi.tooltip(page)).toBeVisible();
    expect(await box(dot)).toEqual(before.cell);
    expect(await box(neighbour)).toEqual(before.next);

    await page.mouse.move(0, 0);
    await expect.poll(() => scaleOf(marker)).toBeCloseTo(1, 2);

    // Keyboard focus (focus-visible) scales the marker the same way and opens the preview.
    await overviewUi.dot(page, 1).focus();
    await page.keyboard.press('ArrowRight');
    await expect(dot).toBeFocused();
    await expect.poll(() => scaleOf(marker)).toBeCloseTo(HOVER_SCALE, 2);
    await expect(overviewUi.tooltip(page)).toBeVisible();
    expect(await box(dot)).toEqual(before.cell);
    expect(await box(neighbour)).toEqual(before.next);
    // Only the focused marker grows.
    expect(await scaleOf(overviewUi.marker(neighbour))).toBe(1);
  },
);

test(
  'QOV-01-AC04 with prefers-reduced-motion the marker scales without any transition',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'qov01-ac04-rm', 2);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openOverview(page, s);
    const dot = overviewUi.dot(page, 1);
    const marker = overviewUi.marker(dot);
    const duration = await marker.evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(duration).toMatch(/^0s(, 0s)*$/);
    const cell = await box(dot);
    await dot.hover();
    // No animation: the very first read after hover is already the final scale.
    await expect(overviewUi.tooltip(page)).toBeVisible();
    expect(await scaleOf(marker)).toBeCloseTo(HOVER_SCALE, 2);
    expect(await box(dot)).toEqual(cell);
  },
);

test(
  'QOV-01-AC05 retry on a correctly answered question shows yellow and clearing it returns to green',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'qov01-ac05', 2);
    const question = q(s, 1);
    await answerCorrectly(s.owner, question);
    await setMyState(s.owner, question.id, { needs_retry: true });
    const overview = await getOverview(s.owner, s.workspaceId);
    expect(overview.counts).toMatchObject({ retry: 1, correct: 0, unseen: 1, total: 2 });

    await openOverview(page, s);
    const dot = overviewUi.dot(page, 1);
    const marker = overviewUi.marker(dot);
    await expect(dot).toHaveAttribute('data-status', 'retry');
    await expect(marker).toHaveCSS('color', await statusColor(page, 'retry'));
    await expect(dot).toHaveAttribute('aria-label', /다시 풀기 표시됨/);
    await expect(dot).toHaveAttribute('aria-label', /마지막 결과 정답/);

    await dot.click();
    const panel = panelUi.numbered(page, 1);
    await panelUi.retryOff(panel).click();
    await expect(panelUi.retryOn(panel)).toBeVisible();
    await panelUi.close(panel).click();
    await expect(panel).toBeHidden();

    await expect(dot).toHaveAttribute('data-status', 'correct');
    await expect(marker).toHaveCSS('color', await statusColor(page, 'correct'));
    await expect(dot).not.toHaveAttribute('aria-label', /다시 풀기 표시됨/);
    const item = await overviewItem(s.owner, s.workspaceId, question.id);
    expect(item).toMatchObject({
      status: 'correct',
      needs_retry: false,
      last_graded_result: 'correct',
    });
    // The retry flag never touched the grading history.
    const attempts = await listAttempts(s.owner, question.id);
    expect(attempts.map((a) => a.result)).toEqual(['correct']);
  },
);

test(
  'QOV-01-AC06 click, Enter or Space opens the modal practice panel and closing restores focus to the marker',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'qov01-ac06', 3);
    await openOverview(page, s);

    // Click → panel; Escape → closed, focus back on the same dot.
    const second = overviewUi.dot(page, 2);
    await second.click();
    const panel = panelUi.numbered(page, 2);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    // Focus is trapped inside the modal panel.
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(second).toBeFocused();

    // Enter → panel; the close button → focus back.
    const third = overviewUi.dot(page, 3);
    await page.keyboard.press('ArrowRight');
    await expect(third).toBeFocused();
    await page.keyboard.press('Enter');
    const thirdPanel = panelUi.numbered(page, 3);
    await expect(thirdPanel).toBeVisible();
    await panelUi.close(thirdPanel).click();
    await expect(thirdPanel).toBeHidden();
    await expect(third).toBeFocused();

    // Space opens it too.
    await page.keyboard.press('Space');
    await expect(thirdPanel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(third).toBeFocused();
    expect((await overviewItem(s.owner, s.workspaceId, q(s, 3).id)).status).toBe('viewed');
  },
);

test(
  'QOV-01-AC07 the workspace home has the header and heatmap without a sidebar; old routes redirect into it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(2 * JOB_TIMEOUT_MS + 60_000);
    const s = await seed(workspaceFactory, 'qov01-ac07', 2);
    await uploadReadyBook(s.owner, s.workspaceId, 'book-ko');
    const paper = await uploadPdf(s.owner, s.workspaceId, questionPaper(), 'question_paper');
    await waitForJob(s.owner, paper.jobId);
    await openOverview(page, s);
    const home = `/workspaces/${s.workspaceId}`;

    // No workspace sidebar (문서/검색/문제/이력/공유 설정) and no visible page title/description.
    await expect(
      page.getByRole('navigation', { name: /workspace 메뉴|workspace menu/i }),
    ).toHaveCount(0);
    await expect(
      main(page).getByRole('link', { name: /^(문서|검색|문제|이력|공유 설정)$/ }),
    ).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(main(page).getByText(/문제 하나가 점 하나입니다/)).toHaveCount(0);

    // Header: unified search with an icon-only submit, then 문서 n · 문제 and the icon buttons
    // 이력 · 공유하기 (UX4). No 문제은행 button: the bank is the 문제 menu's 전체 문제 (UX6-PROGRESS).
    await expect(homeUi.header(page)).toBeVisible();
    await expect(searchUi.box(page)).toBeVisible();
    await expect(searchUi.submit(page)).toHaveText('');
    await expect(homeUi.documentsButton(page)).toHaveText(/문서\s*1$/); // the book; not the paper
    await expect(main(page).getByRole('link', { name: /^(문제은행|question bank)$/i })).toHaveCount(
      0,
    );
    await expect(
      main(page).getByRole('button', { name: /^(문제은행|question bank)$/i }),
    ).toHaveCount(0);
    await expect(homeUi.historyButton(page)).toBeVisible();
    await expect(homeUi.shareButton(page)).toBeVisible();
    await expect(homeUi.shareButton(page)).toHaveText(''); // icon only, named "공유하기"
    await expect(homeUi.historyButton(page)).toHaveText('');
    await expect(homeUi.questionMenuButton(page)).toHaveAttribute('aria-haspopup', 'menu');
    const order = await Promise.all(
      [
        homeUi.documentsButton(page),
        homeUi.questionMenuButton(page),
        homeUi.historyButton(page),
        homeUi.shareButton(page),
      ].map(async (l) => (await l.boundingBox())?.x ?? 0),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The heatmap sits right under the header; no other "PDF 가져오기", no 문제 PDF 관리 /
    // 문제 생성 buttons and no count line (UX4).
    await expect(overviewUi.heatmap(page)).toBeVisible();
    await expect(
      main(page).getByRole('button', { name: /^(문제 pdf 관리|문제 생성)$/i }),
    ).toHaveCount(0);
    await expect(overviewUi.inFilter(page)).toHaveCount(0);
    await expect(
      main(page)
        .getByRole('link', { name: /pdf 가져오기/i })
        .or(main(page).getByRole('button', { name: /pdf 가져오기/i })),
    ).toHaveCount(0);

    // Old section routes land on the home with the matching dialog or state.
    await page.goto(`${home}/documents`);
    await expect(page).toHaveURL(
      (url) => url.pathname === home && url.searchParams.get('panel') === 'documents',
    );
    await expect(homeUi.documentsDialog(page)).toBeVisible();
    await page.goto(`${home}/history`);
    await expect(page).toHaveURL((url) => url.searchParams.get('panel') === 'history');
    await expect(main(page).getByRole('dialog', { name: /^(이력|history)$/i })).toBeVisible();
    await page.goto(`${home}/settings/sharing`);
    await expect(page).toHaveURL((url) => url.searchParams.get('panel') === 'share');
    await expect(homeUi.shareDialog(page)).toBeVisible();
    await page.goto(`${home}/questions?favorite=true`);
    await expect(page).toHaveURL(
      (url) => url.pathname === home && url.searchParams.get('favorite') === 'true',
    );
    await expect(overviewUi.heatmap(page)).toHaveCount(0); // no favorites yet: filtered empty state
    await page.goto(`${home}/search?q=chlorine&mode=keyword`);
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === home &&
        url.searchParams.get('scope') === 'content' &&
        url.searchParams.get('q') === 'chlorine',
    );
    await expect(searchUi.resultsRegion(page)).toBeVisible();

    // A member who is not the owner: no 공유하기, `?panel=share` opens nothing, the API refuses.
    const viewer = await workspaceFactory.member('qov01-ac07-viewer');
    seedMembership(s.workspaceId, viewer.user.id, 'viewer');
    await page.context().clearCookies();
    await signInAs(page, viewer.user);
    await page.goto(`${home}?panel=share`);
    await expect(overviewUi.heatmap(page)).toBeVisible();
    await expect(homeUi.shareButton(page)).toHaveCount(0);
    await expect(homeUi.shareDialog(page)).toHaveCount(0);
    await homeUi.questionMenuButton(page).click();
    await expect(homeUi.questionMenu(page).getByRole('menuitem')).toHaveCount(2);
    await expect(homeUi.questionMenuItem(page, 'bank')).toBeVisible();
    await expect(homeUi.questionMenuItem(page, 'pdfs')).toBeVisible();
    // A viewer reaches the bank through 전체 문제 too (UX6-PROGRESS).
    await homeUi.questionMenuItem(page, 'bank').click();
    await expect(page).toHaveURL((url) => url.pathname === `${home}/questions/bank`);
    await expect(
      page.getByRole('heading', { level: 1, name: /^(전체 문제|all questions)$/i }),
    ).toBeVisible();
    await page.goto(home);
    const denied = await viewer.api.request('GET', `/workspaces/${s.workspaceId}/share-links`);
    expect(denied.status).toBe(403);
  },
);

test(
  'QOV-01-AC08 no status legend or summary; the status filter is collapsed until its chevron toggle opens it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'qov01-ac08', 3);
    await setMyState(s.owner, q(s, 2).id, { needs_retry: true });
    await openOverview(page, s);

    await expect(
      main(page).getByRole('region', { name: /문제 상태 요약|status summary/i }),
    ).toHaveCount(0);
    await expect(main(page).getByRole('list', { name: /상태 범례|legend/i })).toHaveCount(0);

    const toggle = homeUi.statusFilterToggle(page);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const controls = await toggle.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    await expect(homeUi.statusFilters(page)).toHaveCount(0); // hidden
    await expect(toggle.locator('svg')).toHaveCount(1); // chevron icon

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const filters = homeUi.statusFilters(page);
    await expect(filters).toBeVisible();
    await expect(filters).toHaveAttribute('id', controls ?? '');
    // Each status is a swatch plus its text (never colour alone).
    for (const label of ['미열람', '열람', '오답', '정답', '다시 풀기']) {
      await expect(filters.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    await filters.getByRole('button', { name: '다시 풀기', exact: true }).click();
    await expect(page).toHaveURL(/[?&]status=retry(&|$)/);
    await expect(overviewUi.dots(page)).toHaveCount(1);

    // Collapsing keeps the filter applied (and says so in text).
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(homeUi.statusFilters(page)).toHaveCount(0);
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(page).toHaveURL(/[?&]status=retry(&|$)/);
    await expect(main(page).getByText(/상태 필터 적용 중|status filter on/i)).toBeVisible();

    // UX4: at 375px the chips wrap as whole chips; none is squeezed or wraps its label, and the
    // page never scrolls sideways.
    await page.setViewportSize({ width: 375, height: 800 });
    await toggle.click();
    const chips = homeUi.statusFilters(page).getByRole('button');
    const heights = new Set<number>();
    for (const chip of await chips.all()) {
      const fits = await chip.evaluate((el) => el.scrollWidth <= el.clientWidth);
      expect(fits).toBe(true);
      heights.add(Math.round((await chip.boundingBox())?.height ?? 0));
    }
    expect(heights.size).toBe(1); // one line each: same height
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  },
);

test(
  'QOV-01-AC09 dialogs open at once with a skeleton while loading; sub-pages show their route skeleton',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'qov01-ac09', 2);
    await openOverview(page, s);

    // Hold the history reads: the dialog is already open, busy, with a status text.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => /\/api\/workspaces\/[^/]+\/(activities|jobs|attempts)$/.test(url.pathname),
      async (route) => {
        await gate;
        await route.fallback();
      },
    );
    await homeUi.historyButton(page).click();
    const dialog = main(page).getByRole('dialog', { name: /^(이력|history)$/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[aria-busy="true"]')).toBeVisible();
    await expect(dialog.getByRole('status')).toHaveText(/불러오는 중|loading/i);
    release();
    await expect(dialog.getByRole('list', { name: /^(이력|history)$/i })).toBeVisible();
    await expect(dialog.locator('[aria-busy="true"]')).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });

    // 전체 문제 (the bank): the route skeleton shows while the page's server render is held back.
    let releasePage!: () => void;
    const pageGate = new Promise<void>((resolve) => (releasePage = resolve));
    await page.route(
      (url) => url.pathname.endsWith('/questions/bank'),
      async (route) => {
        if (route.request().resourceType() === 'document') return route.fallback();
        await pageGate;
        await route.fallback();
      },
    );
    await chooseQuestionMenu(page, 'bank');
    await expect(
      main(page)
        .getByRole('status')
        .filter({ hasText: /전체 문제를 불러오는 중|loading all questions/i }),
    ).toBeVisible();
    releasePage();
    await expect(
      page.getByRole('heading', { level: 1, name: /^(전체 문제|all questions)$/i }),
    ).toBeVisible();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  },
);

test(
  'QOV-01-AC10 a dialog opened later stacks above one already open; each closes on its own',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'qov01-ac10', 1);
    await openOverview(page, s);

    await homeUi.documentsButton(page).click();
    const documents = homeUi.documentsDialog(page);
    await expect(documents).toBeVisible();
    await expect(documents).not.toHaveAttribute('aria-modal', 'true');
    // The background stays usable while a dialog is open.
    await homeUi.historyButton(page).click();
    const history = main(page).getByRole('dialog', { name: /^(이력|history)$/i });
    await expect(history).toBeVisible();
    await expect(documents).toBeVisible();
    await expect(page).toHaveURL(/panel=documents&panel=history/);

    const z = (l: Locator) => l.evaluate((el) => Number(getComputedStyle(el).zIndex));
    expect(await z(history)).toBeGreaterThan(await z(documents));

    // Pressing 문서 again brings its (covered) dialog back on top.
    await homeUi.documentsButton(page).click();
    await expect.poll(async () => (await z(documents)) > (await z(history))).toBe(true);

    await documents.getByRole('button', { name: /문서 관리 닫기|close/i }).click();
    await expect(documents).toBeHidden();
    await expect(history).toBeVisible();
    await expect(page).toHaveURL((url) => url.searchParams.getAll('panel').join() === 'history');
    await history.getByRole('button', { name: /이력 닫기|close/i }).focus();
    await page.keyboard.press('Escape');
    await expect(history).toBeHidden();
    await expect(page).toHaveURL((url) => !url.searchParams.has('panel'));
  },
);

test(
  'QOV-01-AC11 the header 문제 menu opens 전체 문제, PDF 관리, 직접 추가 and 변형 출제 by mouse and keyboard',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'qov01-ac11', 1);
    await openOverview(page, s);

    // Keyboard: Enter opens the menu on its first item; Escape closes it back to the button.
    const button = homeUi.questionMenuButton(page);
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(homeUi.questionMenu(page)).toBeVisible();
    await expect(homeUi.questionMenu(page).getByRole('menuitem')).toHaveText([
      /^(전체 문제|all questions)$/i,
      /^(pdf 관리|manage pdfs?)$/i,
      /^(직접 추가|add question)$/i,
      /^(변형 출제|generate variants?)$/i,
    ]);
    await expect(homeUi.questionMenuItem(page, 'bank')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(homeUi.questionMenu(page)).toBeHidden();
    await expect(button).toBeFocused();

    // PDF 관리 (Enter, then ArrowDown to the second item) → the 문제 PDF 관리 dialog.
    await page.keyboard.press('Enter');
    await expect(homeUi.questionMenuItem(page, 'bank')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(homeUi.questionMenuItem(page, 'pdfs')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(homeUi.questionPdfsDialog(page)).toBeVisible();
    await expect(page).toHaveURL((url) =>
      url.searchParams.getAll('panel').includes('question-pdfs'),
    );

    // 변형 출제 → the 문제 생성 dialog, on top.
    await chooseQuestionMenu(page, 'generate');
    await expect(homeUi.generateDialog(page)).toBeVisible();
    await expect(page).toHaveURL((url) => url.searchParams.getAll('panel').includes('generate'));

    // 직접 추가 → the bank with its 문제 등록 editor open; a reload does not reopen it.
    await page.goto(overviewPath(s.workspaceId));
    await chooseQuestionMenu(page, 'create');
    await expect(page).toHaveURL(new RegExp(`/workspaces/${s.workspaceId}/questions/bank`));
    await expect(questionFormUi.form(page)).toBeVisible();
    await expect(page).toHaveURL((url) => !url.searchParams.has('create'));
    await page.reload();
    await expect(
      page.getByRole('heading', { level: 1, name: /^(전체 문제|all questions)$/i }),
    ).toBeVisible();
    await expect(questionFormUi.form(page)).toHaveCount(0);

    // 전체 문제 → the bank page, titled 전체 문제 too (UX6-PROGRESS, UX6-BANK).
    await page.goto(overviewPath(s.workspaceId));
    await chooseQuestionMenu(page, 'bank');
    await expect(page).toHaveURL(
      (url) => url.pathname === `/workspaces/${s.workspaceId}/questions/bank` && url.search === '',
    );
    await expect(
      page.getByRole('heading', { level: 1, name: /^(전체 문제|all questions)$/i }),
    ).toBeVisible();
  },
);
