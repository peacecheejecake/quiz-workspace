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
  archiveQuestion,
  createQuestion,
  detailUi,
  getQuestion,
  INACTIVE_STATUS_OPTIONS,
  inactiveUi,
  numberedMcq,
  book,
  chooseFilter,
  chooseQuestionMenu,
  createNumberedQuestions,
  dedupUi,
  docUi,
  draftFor,
  expect,
  expectReadOnlyQuestionMenu,
  fillMcq,
  getOverview,
  homeUi,
  importPaperDrafts,
  JOB_TIMEOUT_MS,
  listAttempts,
  listQuestions,
  main,
  mcqInput,
  overviewItem,
  outlineNodeId,
  overviewPath,
  overviewUi,
  panelUi,
  PROBLEM_TYPES,
  publishDrafts,
  questionFormUi,
  questionPaper,
  scaleOf,
  scanDuplicates,
  searchUi,
  section,
  seedMembership,
  setMyState,
  signInAs,
  startPractice,
  statusColor,
  submitPractice,
  test,
  truthQuestion,
  uploadPdf,
  uploadReadyBook,
  waitForJob,
  type E2EFixtures,
  type Member,
  type Problem,
  type Question,
} from '../fixtures/test.ts';
import { homeBackgroundUi, homeDialogUi, isBlocked } from '../fixtures/ux9-pages.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const HOVER_SCALE = 1.18;
const BOOK = book('book-ko');
const CH1 = section(BOOK, 'ch1'); // "1장 물의 순환"

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

    // Header: the 문제 search and the collapsed "본문 검색" disclosure (UX7-SEARCH), then 문서 n ·
    // 문제 and the icon buttons 이력 · 공유하기 (UX4). No 문제은행 button (UX6-PROGRESS) and no
    // 전체 문제 page (UX7-BANK).
    await expect(homeUi.header(page)).toBeVisible();
    await expect(homeUi.questionSearch(page)).toBeVisible();
    await expect(homeUi.contentSearchToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(searchUi.box(page)).toBeHidden();
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
        url.searchParams.get('text') === 'chlorine' &&
        !url.searchParams.has('q') &&
        !url.searchParams.has('scope'),
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
    // A viewer keeps the 문제 button (UX7-DOCS-2) with 직접 추가 / 중복 문제 정리 disabled; no
    // 전체 문제 (UX7-BANK), no PDF 관리 (UX7-DOCS).
    await expectReadOnlyQuestionMenu(page, 'viewer');
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
    test.setTimeout(JOB_TIMEOUT_MS + 60_000);
    const s = await seed(workspaceFactory, 'qov01-ac09', 2);
    // A question paper with an extraction, for the 문제 검토 sub-page link below (read with the
    // home's document list, so it is made before the home loads).
    await importPaperDrafts(s.owner, s.workspaceId);
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
    // UX9 (HOMEDLG-01): modal — the header behind it is inert until it closes.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // A sub-page (문제 PDF 가져오기, from the 문서 관리 row's 문제 검토 link; QGEN-RM moved this
    // off the retired 변형 출제 review page): the route skeleton shows while the page's server
    // render is held back. The link prefetches the route once it is visible, and those prefetches
    // carry the loading boundary. 문제 검토 is chosen only once every one of them has been
    // delivered: a click before they land makes Next render the skeleton from the navigation's
    // own streamed response, which the gate holds whole (the WebKit flake, UX7-FLAKE-AC09).
    let releasePage!: () => void;
    const pageGate = new Promise<void>((resolve) => (releasePage = resolve));
    let prefetching = 0;
    let prefetched = 0;
    await page.route(
      (url) => url.pathname.endsWith('/questions/import'),
      async (route) => {
        // Only the navigation's render is held: the document and the link's prefetches go through.
        const request = route.request();
        if (request.resourceType() === 'document') return route.fallback();
        if (request.headers()['next-router-prefetch'] !== undefined) {
          prefetching += 1;
          try {
            // Fulfilled whole, so "delivered" is observable (Response.finished() can hang on
            // Chromium).
            await route.fulfill({ response: await route.fetch() });
            prefetched += 1;
          } finally {
            prefetching -= 1;
          }
          return;
        }
        await pageGate;
        await route.fallback();
      },
    );
    await homeUi.documentsButton(page).click();
    const review = docUi.reviewLink(homeUi.documentsDialog(page));
    await expect(review).toBeVisible({ timeout: JOB_TIMEOUT_MS });
    await expect.poll(() => prefetched > 0 && prefetching === 0).toBe(true);
    await review.click();
    await expect(
      main(page)
        .getByRole('status')
        .filter({ hasText: /문제 pdf 가져오기를 불러오는 중|loading/i }),
    ).toBeVisible();
    releasePage();
    await expect(
      page.getByRole('heading', { level: 1, name: /^(문제 pdf 가져오기|import)/i }),
    ).toBeVisible();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  },
);

test(
  'QOV-01-AC10 while a home dialog is open the other dialog buttons are inert; its close button or Escape closes it and drops its panel',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'qov01-ac10', 1);
    await openOverview(page, s);

    // UX9 (HOMEDLG-01): 이력 is modal, the header behind it is inert.
    await homeUi.historyButton(page).click();
    const history = page.getByRole('dialog', { name: /^(이력|history)$/i });
    await expect(history).toBeVisible();
    await expect(history).toHaveAttribute('aria-modal', 'true');
    const documentsButton = homeBackgroundUi.documentsButton(page);
    expect(await isBlocked(documentsButton), '문서 n is inert').toBe(true);
    expect(await isBlocked(homeBackgroundUi.questionMenuButton(page)), '문제 is inert').toBe(true);
    // A real click where 문서 n is (left of the dialog) lands on the backdrop: it closes 이력
    // (nothing unsaved) and opens no other dialog.
    const box = await documentsButton.boundingBox();
    if (!box) throw new Error('문서 n is not visible');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(history).toHaveCount(0);
    await expect(homeUi.documentsDialog(page)).toHaveCount(0);
    await expect(page).toHaveURL((url) => !url.searchParams.has('panel'));

    // The 모의고사 dialog: its close button drops `panel=mock-exams`.
    await chooseQuestionMenu(page, 'mockExams');
    const mockExams = page.getByRole('dialog', { name: /^(모의고사|mock exams?)$/i });
    await expect(mockExams).toBeVisible();
    await expect(mockExams).toHaveAttribute('aria-modal', 'true');
    await expect(page).toHaveURL((url) => url.searchParams.getAll('panel').join() === 'mock-exams');
    await mockExams.getByRole('button', { name: /모의고사 닫기|close/i }).click();
    await expect(mockExams).toBeHidden();
    await expect(page).toHaveURL((url) => !url.searchParams.has('panel'));

    // 이력: Escape closes it wherever focus is inside it (modal: focus never leaves it).
    await homeUi.historyButton(page).click();
    await expect(history).toBeVisible();
    await expect(page).toHaveURL((url) => url.searchParams.getAll('panel').join() === 'history');
    await page.keyboard.press('Escape');
    await expect(history).toBeHidden();
    await expect(page).toHaveURL((url) => !url.searchParams.has('panel'));
    await expect(homeUi.historyButton(page)).toBeFocused();
  },
);

test(
  'QOV-01-AC11 the header 문제 menu opens 직접 추가 and 모의고사 by mouse and keyboard, without 변형 출제, 전체 문제 or PDF 관리; viewers and archived workspaces keep the button with the editor items disabled and the reason',
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
      /^(직접 추가|add question)$/i,
      /^(중복 문제 정리|clean up duplicates|duplicate questions)$/i,
      /^(보관·초안 문제|archived and draft questions)$/i,
      // MOCK-01 (MOCK-W): mock exams; QVIEW-01 (QVIEW-W): the range run — both for every member.
      /^(모의고사|mock exams?)$/i,
      /^(문제 풀기|practice questions?|start practice)$/i,
    ]);
    await expect(
      homeUi.questionMenu(page).getByRole('menuitem', { name: /^(전체 문제|all questions)$/i }),
    ).toHaveCount(0);
    // UX7-DOCS: PDF 관리 moved into 문서 관리 (DOC-01-AC09); QGEN-RM retired 변형 출제.
    await expect(homeUi.questionMenuItem(page, 'pdfs')).toHaveCount(0);
    await expect(homeUi.questionMenuItem(page, 'generate')).toHaveCount(0);
    await expect(homeUi.questionMenuItem(page, 'create')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(homeUi.questionMenuItem(page, 'duplicates')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(homeUi.questionMenu(page)).toBeHidden();
    await expect(button).toBeFocused();

    // 모의고사 by keyboard (Enter opens the menu on 직접 추가; ArrowDown past 중복 문제 정리 and
    // 보관·초안 문제; Enter).
    await page.keyboard.press('Enter');
    await expect(homeUi.questionMenuItem(page, 'create')).toBeFocused();
    for (const item of ['duplicates', 'inactive', 'mockExams'] as const) {
      await page.keyboard.press('ArrowDown');
      await expect(homeUi.questionMenuItem(page, item)).toBeFocused();
    }
    await page.keyboard.press('Enter');
    await expect(
      main(page).getByRole('dialog', { name: /^(모의고사|mock exams?)$/i }),
    ).toBeVisible();
    await expect(page).toHaveURL((url) => url.searchParams.getAll('panel').includes('mock-exams'));
    await expect(homeUi.generateDialog(page)).toHaveCount(0);

    // 직접 추가 by mouse → the 문제 등록 dialog on the home (UX7-BANK): same path, `?panel=question-create`,
    // modal; closing it drops the panel value.
    await page.goto(overviewPath(s.workspaceId));
    await chooseQuestionMenu(page, 'create');
    const form = questionFormUi.form(page);
    await expect(form).toBeVisible();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/workspaces/${s.workspaceId}` &&
        url.searchParams.getAll('panel').includes('question-create'),
    );
    await page.keyboard.press('Escape');
    await expect(form).toBeHidden();
    await expect(page).toHaveURL((url) => !url.searchParams.has('panel'));
    await expect(homeUi.questionMenuButton(page)).toBeFocused();

    // Without edit rights the button stays (UX7-DOCS-2): a viewer, then the archived workspace's
    // owner, see the editor items (직접 추가, 중복 문제 정리) disabled with the reason in text.
    const viewer = await workspaceFactory.member('qov01-ac11-viewer');
    seedMembership(s.workspaceId, viewer.user.id, 'viewer');
    await page.context().clearCookies();
    await signInAs(page, viewer.user);
    await page.goto(overviewPath(s.workspaceId));
    await expect(overviewUi.heatmap(page)).toBeVisible();
    await expectReadOnlyQuestionMenu(page, 'viewer');

    await workspaceFactory.archive(s.owner, s.workspaceId);
    await page.context().clearCookies();
    await openOverview(page, s);
    await expectReadOnlyQuestionMenu(page, 'archived');
  },
);

test(
  'QOV-01-AC12 직접 추가 and the empty heatmap open the 문제 등록 dialog on the home; a saved MCQ becomes a dot in its chapter',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(JOB_TIMEOUT_MS + 90_000);
    const owner = await workspaceFactory.member('qov01-ac12');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const chapterId = await outlineNodeId(owner, documentId, CH1.title);
    expect(await listQuestions(owner, ws.id)).toEqual([]);
    const home = `/workspaces/${ws.id}`;
    const onHomeWithEditor = (url: URL) =>
      url.pathname === home && url.searchParams.getAll('panel').includes('question-create');

    await signInAs(page, owner.user);
    await page.goto(home);
    // The empty heatmap's 문제 등록 opens the editor on the home, not another page.
    const emptyCreate = main(page).getByRole('button', { name: /^(문제 등록|add question)$/i });
    await expect(emptyCreate).toBeVisible();
    await emptyCreate.click();
    const form = questionFormUi.form(page);
    await expect(form).toBeVisible();
    await expect(page).toHaveURL(onHomeWithEditor);
    await page.keyboard.press('Escape');
    await expect(form).toBeHidden();
    await expect(page).toHaveURL((url) => url.pathname === home && !url.searchParams.has('panel'));

    // 문제 › 직접 추가: an MCQ without a correct option is refused and nothing is saved.
    await chooseQuestionMenu(page, 'create');
    await expect(page).toHaveURL(onHomeWithEditor);
    const text = `물이 액체에서 기체로 변하는 과정은? [${ws.id.slice(0, 8)}]`;
    const options = ['응결', '증발', '강수', '침전'];
    await fillMcq(page, text, options, 0);
    await questionFormUi.save(form).click();
    await expect(questionFormUi.alert(form)).toContainText(/정답|correct/i);
    expect(await listQuestions(owner, ws.id)).toEqual([]);

    await questionFormUi.correct(form, 2).check();
    await chooseFilter(page, questionFormUi.chapter(form), new RegExp(CH1.title));
    await questionFormUi.save(form).click();
    await expect(form).toBeHidden();
    await expect(page).toHaveURL((url) => url.pathname === home && !url.searchParams.has('panel'));

    // The heatmap re-reads: one dot in that chapter's group.
    const group = overviewUi.heatmap(page).getByRole('region', { name: new RegExp(CH1.title) });
    await expect(group.getByRole('button', { name: /\d+번 문제|question \d+/i })).toHaveCount(1);
    await expect(overviewUi.dots(page)).toHaveCount(1);

    // Server: one CONFIRMED MCQ in that chapter, answered by the stable id of "증발".
    const [saved, ...rest] = await listQuestions(owner, ws.id);
    expect(rest).toEqual([]);
    expect(saved).toMatchObject({
      question_type: 'MCQ',
      publication_status: 'CONFIRMED',
      chapter_id: chapterId,
    });
    expect(saved?.revision.stem).toBe(text);
    expect(saved?.revision.options.map((o) => o.text)).toEqual(options);
    const evaporation = saved?.revision.options.find((o) => o.text === '증발');
    expect(evaporation).toBeDefined();
    expect(saved?.revision.correct_option_ids).toEqual([evaporation?.id]);

    await page.reload();
    await expect(overviewUi.dots(page)).toHaveCount(1);

    // Viewer: no 직접 추가, `?panel=question-create` opens nothing, the API refuses.
    const viewer = await workspaceFactory.member('qov01-ac12-viewer');
    seedMembership(ws.id, viewer.user.id, 'viewer');
    const refused = await viewer.api.request(
      'POST',
      `/workspaces/${ws.id}/questions`,
      mcqInput('viewer', ['a', 'b'], 0),
    );
    expect(refused.status).toBe(403);
    expect((refused.body as Problem).type).toBe(PROBLEM_TYPES.insufficientRole);
    await page.context().clearCookies();
    await signInAs(page, viewer.user);
    await page.goto(`${home}?panel=question-create`);
    await expect(overviewUi.heatmap(page)).toBeVisible();
    await expect(questionFormUi.form(page)).toHaveCount(0);
    // The 문제 button stays; 직접 추가 is disabled with the reason (UX7-DOCS-2).
    await expectReadOnlyQuestionMenu(page, 'viewer');

    // Archived: read-only for the owner too.
    await workspaceFactory.archive(owner, ws.id);
    const archived = await owner.api.request(
      'POST',
      `/workspaces/${ws.id}/questions`,
      mcqInput('archived', ['a', 'b'], 0),
    );
    expect(archived.status).toBe(403);
    expect((archived.body as Problem).type).toBe(PROBLEM_TYPES.workspaceArchived);
    await page.context().clearCookies();
    await signInAs(page, owner.user);
    await page.goto(`${home}?panel=question-create`);
    await expect(overviewUi.heatmap(page)).toBeVisible();
    await expect(questionFormUi.form(page)).toHaveCount(0);
    await expectReadOnlyQuestionMenu(page, 'archived');
  },
);

test(
  'QOV-01-AC13 sub-pages show a back link and a breadcrumb to the home; the retired /questions/bank and /questions/generate redirect home',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(JOB_TIMEOUT_MS + 60_000);
    const owner = await workspaceFactory.member('qov01-ac13');
    const ws = await workspaceFactory.create(owner);
    const [question] = await createNumberedQuestions(owner, ws.id, 'qov01-ac13', 1);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const home = `/workspaces/${ws.id}`;
    const nav = () => page.getByRole('navigation', { name: /^(위치|breadcrumb)$/i });
    async function expectSubPageNav(current: RegExp, middle?: RegExp): Promise<void> {
      await expect(nav()).toBeVisible();
      await expect(nav().getByRole('link', { name: ws.name, exact: true })).toHaveAttribute(
        'href',
        home,
      );
      if (middle) await expect(nav().getByRole('link', { name: middle })).toBeVisible();
      await expect(nav().locator('[aria-current="page"]')).toHaveText(current);
      // The location row keeps 12px of space above the page title (UX5-UI).
      const [navBox, titleBox] = await Promise.all([
        nav().boundingBox(),
        main(page).getByRole('heading', { level: 1 }).boundingBox(),
      ]);
      expect(navBox && titleBox && titleBox.y - (navBox.y + navBox.height)).toBeGreaterThanOrEqual(
        12,
      );
      await expect(main(page).getByRole('link', { name: /workspace 홈|back/i })).toHaveAttribute(
        'href',
        home,
      );
      // No link to the retired 전체 문제 page (UX7-BANK).
      await expect(
        main(page).getByRole('link', { name: /^(전체 문제|all questions)$/i }),
      ).toHaveCount(0);
    }

    await signInAs(page, owner.user);
    await page.goto(`${home}/questions/import`);
    await expectSubPageNav(/^(문제 pdf 가져오기|import)/i);
    // The breadcrumb's workspace link and the back link both return home.
    await nav().getByRole('link', { name: ws.name, exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === home);
    await expect(homeUi.header(page)).toBeVisible();
    await page.goto(`${home}/documents/${documentId}`);
    await expectSubPageNav(/물의 순환과 정수 처리|book-ko/i, /^(문서 관리|documents)$/i);
    await main(page)
      .getByRole('link', { name: /workspace 홈|back/i })
      .click();
    await expect(page).toHaveURL((url) => url.pathname === home);
    await expect(homeUi.header(page)).toBeVisible();

    // The retired bank route: the home, keeping only `?question=` (its practice panel opens).
    await page.goto(`${home}/questions/bank?status=ALL&create=1`);
    await expect(page).toHaveURL((url) => url.pathname === home && url.search === '');
    await expect(overviewUi.heatmap(page)).toBeVisible();
    await expect(questionFormUi.form(page)).toHaveCount(0);
    await page.goto(`${home}/questions/bank?question=${question?.id}`);
    await expect(page).toHaveURL(
      (url) => url.pathname === home && url.searchParams.get('question') === question?.id,
    );
    await expect(panelUi.numbered(page, 1)).toBeVisible();

    // The retired 변형 출제 review and batch pages (QGEN-RM): the home with the 모의고사 dialog
    // that replaced them; their query is dropped.
    for (const query of [`source=${question?.id}`, 'batch=00000000-0000-4000-8000-000000000000']) {
      await page.goto(`${home}/questions/generate?${query}`);
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === home &&
          url.searchParams.getAll('panel').join() === 'mock-exams' &&
          [...url.searchParams.keys()].join() === 'panel',
      );
      await expect(
        main(page).getByRole('dialog', { name: /^(모의고사|mock exams?)$/i }),
      ).toBeVisible();
    }
  },
);

test(
  'QOV-01-AC14 browser Back or Forward after closing a dialog or the practice panel never reopens it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(180_000);
    const s = await seed(workspaceFactory, 'qov01-ac14', 2);
    // A ready book: its 문서 관리 row's 요약 opens 문서 요약 stacked on 문서 관리 (UX9).
    await uploadReadyBook(s.owner, s.workspaceId, 'book-ko');
    const bookTitle = 'book-ko';
    const home = overviewPath(s.workspaceId);
    const onHome = (url: URL) => url.pathname === home;
    const onList = (url: URL) => url.pathname === '/workspaces';
    const noPanel = (url: URL) =>
      onHome(url) && !url.searchParams.has('panel') && !url.searchParams.has('question');
    const panels = (url: URL) => url.searchParams.getAll('panel').join();
    const history = homeUi.dialog(page, /^(이력|history)$/i);
    const documents = homeUi.documentsDialog(page);
    const closeDocuments = /^(문서 관리 닫기|close)/i;
    await signInAs(page, s.owner.user);

    /** A history entry before the home (the workspace list), then the home itself. */
    async function arrive(
      search = '',
      // UX9: a deep-linked modal dialog hides the heatmap from assistive technology.
      ready = search.includes('panel=')
        ? page.getByRole('dialog').first()
        : overviewUi.heatmap(page),
    ): Promise<void> {
      await gotoAfterReload('/workspaces');
      await expect(page).toHaveURL(onList);
      await page.goto(`${home}${search}`);
      await expect(ready).toBeVisible();
    }
    // A close may refresh the overview (the practice panel's study state): a cross-document
    // traversal started under that router write is cancelled by WebKit, not by the feature.
    async function back(): Promise<void> {
      await page.waitForLoadState('networkidle');
      await page.goBack();
    }
    async function forward(): Promise<void> {
      await page.waitForLoadState('networkidle');
      await page.goForward();
    }
    /** After a close, Back leaves the home for the page before it: the dialog never reopens. */
    async function backLeavesHome(): Promise<void> {
      await back();
      await expect(page).toHaveURL(onList);
    }
    /** From the page before the home, Forward returns to the closed home and no further. */
    async function forwardStaysClosed(closed: Locator): Promise<void> {
      await forward();
      await expect(page).toHaveURL(noPanel);
      await expect(overviewUi.heatmap(page)).toBeVisible();
      await forward();
      await expect(page).toHaveURL(noPanel);
      await expect(closed).toBeHidden();
    }
    /**
     * WebKit loads the home afresh on the first Forward above; the second one restores an entry
     * the previous document wrote, which Next may then load once more (the same closed address).
     * A navigation the test starts meanwhile is interrupted by that reload: start it again.
     */
    async function gotoAfterReload(url: string): Promise<void> {
      try {
        await page.goto(url);
      } catch (error) {
        if (!String(error).includes('interrupted by another navigation')) throw error;
        await expect(page).toHaveURL(noPanel);
        await page.waitForLoadState('load');
        await page.goto(url);
      }
    }

    // 문서 관리 · 이력 · 링크 공유: open, close (button or Escape), Back, Forward.
    const dialogs = [
      {
        open: () => homeUi.documentsButton(page).click(),
        dialog: documents,
        close: closeDocuments,
      },
      {
        open: () => homeUi.historyButton(page).click(),
        dialog: history,
        close: /^(이력 닫기|close)/i,
      },
      {
        open: () => homeUi.shareButton(page).click(),
        dialog: homeUi.shareDialog(page),
        close: /^(공유 관리 닫기|close)/i,
      },
    ];
    for (const [i, { open, dialog, close }] of dialogs.entries()) {
      await arrive();
      await open();
      await expect(dialog).toBeVisible();
      await expect(page).toHaveURL((url) => url.searchParams.has('panel'));
      const closeButton = dialog.getByRole('button', { name: close });
      if (i % 2 === 0) {
        await closeButton.click();
      } else {
        await closeButton.focus();
        await page.keyboard.press('Escape');
      }
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(noPanel);
      await backLeavesHome();
      await forwardStaysClosed(dialog);
    }

    // A filter chosen while a dialog is open survives its close, by Back (UX7 확인 7) or by its
    // close button; neither Back nor Forward reopens the dialog.
    const unseen = (url: URL) => noPanel(url) && url.searchParams.get('status') === 'unseen';
    /**
     * Opens 문서 관리 and picks the 미열람 filter while it is open. UX9 (HOMEDLG-01): the dialog is
     * modal, so the user cannot reach the filter behind it; the filter's own buttons are driven
     * through the DOM to keep the rule covered for any address change made while a dialog is open.
     */
    async function openDocumentsAndFilter(): Promise<void> {
      await arrive();
      await homeUi.documentsButton(page).click();
      await expect(documents).toBeVisible();
      const filters = main(page).getByRole('group', {
        name: /^(상태 필터|status filter)$/i,
        includeHidden: true,
      });
      await main(page)
        .getByRole('button', { name: /^(상태 필터|status filter)$/i, includeHidden: true })
        .dispatchEvent('click');
      await filters
        .getByRole('button', { name: '미열람', exact: true, includeHidden: true })
        .dispatchEvent('click');
      await expect(page).toHaveURL(/[?&]status=unseen(&|$)/);
      await expect(documents).toBeVisible();
    }
    // The close shows the filtered home over the entry before the open: Next reads it, and
    // WebKit cancels a Back started before that read ends.
    const closedRead = () =>
      page.waitForResponse(
        (r) =>
          r.url().includes('_rsc=') &&
          noPanel(new URL(r.url())) &&
          new URL(r.url()).searchParams.get('status') === 'unseen',
      );
    await openDocumentsAndFilter();
    let read = closedRead();
    await back();
    await expect(page).toHaveURL(unseen);
    await expect(documents).toBeHidden();
    await read;
    await forward();
    await expect(page).toHaveURL(unseen);
    await expect(documents).toBeHidden();
    await backLeavesHome();
    await forwardStaysClosed(documents);
    await openDocumentsAndFilter();
    read = closedRead();
    await documents.getByRole('button', { name: closeDocuments }).click();
    await expect(documents).toBeHidden();
    await expect(page).toHaveURL(unseen);
    await read;
    await expect(overviewUi.dots(page)).toHaveCount(2);
    await backLeavesHome();
    await forwardStaysClosed(documents);

    // The 문제 등록 dialog (`?panel=question-create`).
    await arrive();
    await chooseQuestionMenu(page, 'create');
    await expect(questionFormUi.form(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(questionFormUi.form(page)).toBeHidden();
    await expect(page).toHaveURL(noPanel);
    await backLeavesHome();
    await forwardStaysClosed(questionFormUi.form(page));

    // The practice panel: previous/next are question changes (Back/Forward move between the
    // questions, QPLAY-01); Forward does not undo the Back that closed it.
    const onQuestion = (n: number) => (url: URL) =>
      onHome(url) && url.searchParams.get('question') === q(s, n).id;
    await arrive();
    await overviewUi.dot(page, 1).click();
    await expect(panelUi.numbered(page, 1)).toBeVisible();
    await panelUi.next(panelUi.numbered(page, 1)).click();
    await expect(panelUi.numbered(page, 2)).toBeVisible();
    await expect(page).toHaveURL(onQuestion(2));
    await back();
    await expect(page).toHaveURL(onQuestion(1));
    await expect(panelUi.numbered(page, 1)).toBeVisible();
    await forward();
    await expect(page).toHaveURL(onQuestion(2));
    await expect(panelUi.numbered(page, 2)).toBeVisible();
    await back();
    await expect(page).toHaveURL(onQuestion(1));
    await expect(panelUi.numbered(page, 1)).toBeVisible();
    await back();
    await expect(page).toHaveURL(noPanel);
    await expect(panelUi.panel(page)).toBeHidden();
    await forward();
    await expect(page).toHaveURL(noPanel);
    await expect(panelUi.panel(page)).toBeHidden();
    // Moved to the next question, then closed with its button.
    await overviewUi.dot(page, 1).click();
    await expect(panelUi.numbered(page, 1)).toBeVisible();
    await panelUi.next(panelUi.numbered(page, 1)).click();
    const second = panelUi.numbered(page, 2);
    await expect(second).toBeVisible();
    await expect(page).toHaveURL(onQuestion(2));
    await panelUi.close(second).click();
    await expect(panelUi.panel(page)).toBeHidden();
    await expect(page).toHaveURL(noPanel);
    await backLeavesHome();
    await forwardStaysClosed(panelUi.panel(page));

    // Two stacked dialogs (UX9: 문서 요약 opened from a 문서 관리 row stacks on it — buttons
    // behind a modal dialog are inert): each Back closes the top one only, and Forward reopens
    // neither.
    const summary = homeUi.dialog(page, /^(문서 요약|document summary)$/i);
    await arrive();
    await homeUi.documentsButton(page).click();
    await expect(documents).toBeVisible();
    await documents
      .getByRole('button', { name: new RegExp(`^${bookTitle} (요약|summary)$`, 'i') })
      .click();
    await expect(summary).toBeVisible();
    await expect(page).toHaveURL(
      (url) => onHome(url) && panels(url) === 'documents,document-summary',
    );
    await back();
    await expect(page).toHaveURL((url) => onHome(url) && panels(url) === 'documents');
    await expect(summary).toBeHidden();
    await expect(documents).toBeVisible();
    await back();
    await expect(page).toHaveURL(noPanel);
    await expect(documents).toBeHidden();
    await forward();
    await expect(page).toHaveURL(noPanel);
    await expect(documents).toBeHidden();
    await expect(summary).toBeHidden();
    await backLeavesHome();

    // UX9: the lower dialog cannot be closed while one is stacked on it (it is inert); closing
    // the top one with Escape leaves the lower one, the first Back closes that, Forward reopens
    // neither, the next Back leaves the home.
    await arrive('?panel=documents&panel=history');
    await expect(history).toBeVisible();
    // UX9: 문서 관리 is open under 이력, hidden from assistive technology meanwhile.
    await expect(homeDialogUi.documents(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(history).toBeHidden();
    await expect(documents).toBeVisible();
    await expect(page).toHaveURL((url) => panels(url) === 'documents');
    await back();
    await expect(page).toHaveURL(noPanel);
    await expect(history).toBeHidden();
    await expect(documents).toBeHidden();
    await forward();
    await expect(page).toHaveURL(noPanel);
    await expect(history).toBeHidden();
    await expect(documents).toBeHidden();
    await backLeavesHome();

    // Deep links (UX7 확인 7): the dialogs a first load opens close one per Back, then Back
    // leaves the home; closing one with its button stays on the home; Forward reopens nothing.
    await arrive('?panel=history');
    await expect(history).toBeVisible();
    await back();
    await expect(page).toHaveURL(noPanel);
    await expect(history).toBeHidden();
    await backLeavesHome();
    await forwardStaysClosed(history);
    await arrive('?panel=documents&panel=history');
    await expect(history).toBeVisible();
    // UX9: 문서 관리 is open under 이력, hidden from assistive technology meanwhile.
    await expect(homeDialogUi.documents(page)).toBeVisible();
    await back();
    await expect(page).toHaveURL((url) => onHome(url) && panels(url) === 'documents');
    await expect(history).toBeHidden();
    await expect(documents).toBeVisible();
    await back();
    await expect(page).toHaveURL(noPanel);
    await expect(documents).toBeHidden();
    await backLeavesHome();
    await forwardStaysClosed(documents);
    await arrive(`?question=${q(s, 1).id}`, panelUi.numbered(page, 1));
    await back();
    await expect(page).toHaveURL(noPanel);
    await expect(panelUi.panel(page)).toBeHidden();
    await backLeavesHome();
    await arrive('?panel=history');
    await expect(history).toBeVisible();
    await history.getByRole('button', { name: /^(이력 닫기|close)/i }).click();
    await expect(history).toBeHidden();
    await expect(page).toHaveURL(noPanel);
    await expect(overviewUi.heatmap(page)).toBeVisible();
    await backLeavesHome();
    await forwardStaysClosed(history);
    // Reloaded with the deep-linked dialog open: Back still closes it first.
    await arrive('?panel=history');
    await expect(history).toBeVisible();
    await page.reload();
    await expect(history).toBeVisible();
    await back();
    await expect(page).toHaveURL(noPanel);
    await expect(history).toBeHidden();
    await backLeavesHome();
  },
);

test(
  'QOV-01-AC15 the 보관·초안 문제 dialog lists drafts and archived questions with status filters and 더 보기; 보관 해제 and 확정 bring them back to the heatmap, read-only for viewers and archived workspaces',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(120_000);
    const label = 'qov01-ac15';
    const s = await seed(workspaceFactory, label, 2);
    const draftExplanation = `${label} 초안 해설`;
    const draft = await createQuestion(s.owner, s.workspaceId, {
      ...numberedMcq(`${label}-draft`, 3, 1, { explanation: draftExplanation }),
      publication_status: 'DRAFT',
    });
    const archived: Question[] = [];
    for (let start = 10; start < 61; start += 10) {
      const batch = Array.from({ length: Math.min(10, 61 - start) }, (_, i) => start + i);
      archived.push(
        ...(await Promise.all(
          batch.map(async (n) =>
            archiveQuestion(
              s.owner,
              await createQuestion(s.owner, s.workspaceId, numberedMcq(`${label}-arch`, n)),
            ),
          ),
        )),
      );
    }
    expect(archived).toHaveLength(51);
    const restored = archived[0];
    if (!restored) throw new Error('no archived question');
    const viewer = await workspaceFactory.member(`${label}-viewer`);
    seedMembership(s.workspaceId, viewer.user.id, 'viewer');

    await openOverview(page, s);
    await expect(overviewUi.dots(page)).toHaveCount(2);
    await chooseQuestionMenu(page, 'inactive');
    const dialog = inactiveUi.dialog(page);
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/workspaces/${s.workspaceId}` &&
        url.searchParams.getAll('panel').includes('inactive-questions'),
    );
    // 전체 (default): drafts and archived questions only, 50 at a time.
    await expect(inactiveUi.rows(dialog)).toHaveCount(50);
    await expect(dialog).not.toContainText(s.questions[0]?.revision.stem ?? '-');
    await inactiveUi.more(dialog).click();
    await expect(inactiveUi.rows(dialog)).toHaveCount(52);
    await expect(inactiveUi.more(dialog)).toHaveCount(0);

    // 초안: the draft alone, its state in text.
    await chooseFilter(page, inactiveUi.status(dialog), INACTIVE_STATUS_OPTIONS.draft);
    await expect(inactiveUi.rows(dialog)).toHaveCount(1);
    await expect(inactiveUi.rows(dialog)).toContainText(draft.revision.stem);
    await expect(inactiveUi.rows(dialog)).toContainText(/초안|draft/i);
    // 보관됨: the archived ones, paged.
    await chooseFilter(page, inactiveUi.status(dialog), INACTIVE_STATUS_OPTIONS.archived);
    await expect(inactiveUi.rows(dialog)).toHaveCount(50);
    await expect(dialog).not.toContainText(draft.revision.stem);
    await inactiveUi.more(dialog).click();
    await expect(inactiveUi.rows(dialog)).toHaveCount(51);
    await expect(inactiveUi.rows(dialog).first()).toContainText(/보관됨|archived/i);

    // A row opens the read-only detail with the answer, explanation and revisions.
    await chooseFilter(page, inactiveUi.status(dialog), INACTIVE_STATUS_OPTIONS.draft);
    await inactiveUi.open(inactiveUi.row(dialog, draft.revision.stem)).click();
    let detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(draftExplanation);
    await expect(detailUi.historyHeading(detail)).toBeVisible();
    await expect(inactiveUi.confirm(detail)).toBeVisible();
    await expect(inactiveUi.edit(detail)).toBeVisible();
    await expect(inactiveUi.remove(detail)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();

    // 확정 the draft and 보관 해제 one archived question: both leave the list for the heatmap.
    await inactiveUi.confirm(inactiveUi.row(dialog, draft.revision.stem)).click();
    await expect(inactiveUi.rows(dialog)).toHaveCount(0);
    // UX9: the Heatmap behind the modal dialog is hidden from assistive technology.
    await expect(homeBackgroundUi.dots(page)).toHaveCount(3);
    await chooseFilter(page, inactiveUi.status(dialog), INACTIVE_STATUS_OPTIONS.archived);
    const restoredRow = inactiveUi.row(dialog, restored.revision.stem);
    await expect(restoredRow).toHaveCount(1);
    await inactiveUi.restore(restoredRow).click();
    await expect(restoredRow).toHaveCount(0);
    await expect(homeBackgroundUi.dots(page)).toHaveCount(4);
    expect((await getQuestion(s.owner, restored.id)).publication_status).toBe('CONFIRMED');
    expect((await getQuestion(s.owner, draft.id)).publication_status).toBe('CONFIRMED');

    // Closing drops the panel; Back never reopens it (QOV-01-AC14).
    await inactiveUi.close(dialog).click();
    await expect(dialog).toBeHidden();
    await expect(overviewUi.dots(page)).toHaveCount(4);
    await expect(overviewUi.dot(page, 10)).toBeVisible();
    await expect(page).toHaveURL((url) => !url.searchParams.has('panel'));
    // As in AC14: WebKit cancels a cross-document Back started under a pending router refresh
    // (here the status actions' revalidation), not because of the feature.
    await page.waitForLoadState('networkidle');
    await page.goBack();
    await expect(page).toHaveURL(
      (url) => !url.searchParams.getAll('panel').includes('inactive-questions'),
    );
    await page.goto(overviewPath(s.workspaceId));
    await expect(overviewUi.dots(page)).toHaveCount(4);

    // Viewer: the same list and detail, without write controls; the API refuses.
    const other = archived[1];
    if (!other) throw new Error('no archived question');
    const refused = await viewer.api.request('PATCH', `/questions/${other.id}`, {
      base_revision_id: other.revision.id,
      publication_status: 'CONFIRMED',
    });
    expect(refused.status).toBe(403);
    expect((refused.body as Problem).type).toBe(PROBLEM_TYPES.insufficientRole);
    await page.context().clearCookies();
    await signInAs(page, viewer.user);
    await page.goto(overviewPath(s.workspaceId));
    await chooseQuestionMenu(page, 'inactive');
    await expect(inactiveUi.rows(dialog)).toHaveCount(50);
    await expect(inactiveUi.restore(dialog)).toHaveCount(0);
    await expect(inactiveUi.confirm(dialog)).toHaveCount(0);
    await inactiveUi.open(inactiveUi.row(dialog, other.revision.stem)).click();
    detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    await expect(detailUi.correctOptions(detail)).toHaveCount(1);
    for (const control of [inactiveUi.restore, inactiveUi.edit, inactiveUi.remove]) {
      await expect(control(detail)).toHaveCount(0);
    }
    await page.keyboard.press('Escape');

    // Archived workspace: read-only for the owner too, and says so.
    await workspaceFactory.archive(s.owner, s.workspaceId);
    const blocked = await s.owner.api.request('PATCH', `/questions/${other.id}`, {
      base_revision_id: other.revision.id,
      publication_status: 'CONFIRMED',
    });
    expect(blocked.status).toBe(403);
    expect((blocked.body as Problem).type).toBe(PROBLEM_TYPES.workspaceArchived);
    await page.context().clearCookies();
    await openOverview(page, s);
    await chooseQuestionMenu(page, 'inactive');
    await expect(inactiveUi.rows(dialog)).toHaveCount(50);
    await expect(
      dialog.getByText(/보관된 workspace는 읽기 전용입니다|archived workspaces are read-only/i),
    ).toBeVisible();
    await expect(inactiveUi.restore(dialog)).toHaveCount(0);
    expect((await getQuestion(s.owner, other.id)).publication_status).toBe('ARCHIVED');
  },
);

// --- UX7-DEDUP 중복 문제 정리 (QOV-01-AC16/AC17, docs/questions.md §10) ---------------------------

const DEDUP_STEM = (label: string) => `${label} 다음 중 물의 순환에 대한 설명으로 옳은 것은?`;
const DEDUP_TEXTS = ['증발은 액체가 기체로 변한다', '응결은 기체가 고체로 변한다', '강수는 없다'];

/** The same MCQ as `DEDUP_STEM(label)` / `DEDUP_TEXTS` (answer: the first text), restyled. */
function dedupMcq(
  label: string,
  n: number,
  style: 'plain' | 'circled' | 'spaced' = 'plain',
): ReturnType<typeof mcqInput> & { question_number: number } {
  const stem = DEDUP_STEM(label);
  const texts =
    style === 'circled'
      ? [`③ ${DEDUP_TEXTS[2]}`, `① ${DEDUP_TEXTS[0]}`, `② ${DEDUP_TEXTS[1]}`]
      : style === 'spaced'
        ? DEDUP_TEXTS.map((t) => `${t.replace(/ /g, '  ')}.`)
        : DEDUP_TEXTS;
  const answer = style === 'circled' ? 1 : 0;
  return {
    ...mcqInput(style === 'spaced' ? `${stem.replace(/ /g, '  ')} ( )` : stem, texts, answer),
    question_number: n,
  };
}

/** Opens 문제 › 중복 문제 정리 and waits for the scan. */
async function openDedup(page: Page): Promise<Locator> {
  await chooseQuestionMenu(page, 'duplicates');
  const dialog = dedupUi.dialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[aria-busy="true"]')).toHaveCount(0);
  return dialog;
}

/** 선택한 묶음 정리 (k) → 보관 in the confirmation. */
async function mergeSelected(page: Page, dialog: Locator, archived: number): Promise<void> {
  await expect(dedupUi.merge(dialog)).toContainText(`(${archived})`);
  await dedupUi.merge(dialog).click();
  const confirm = dedupUi.confirm(page);
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveAccessibleName(new RegExp(`${archived}개|${archived} dup`));
  await dedupUi.confirmButton(confirm).click();
  await expect(confirm).toBeHidden();
}

test(
  'QOV-01-AC16 중복 문제 정리 groups identical questions across option order, numbering and spacing; keeping one archives the rest, read-only for viewers and archived workspaces',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(120_000);
    const label = 'qov01-ac16';
    const owner = await workspaceFactory.member(label);
    const ws = await workspaceFactory.create(owner);
    const first = await createQuestion(owner, ws.id, dedupMcq(label, 1));
    const second = await createQuestion(owner, ws.id, dedupMcq(label, 2, 'circled'));
    const third = await createQuestion(owner, ws.id, dedupMcq(label, 3, 'spaced'));
    await createQuestion(owner, ws.id, numberedMcq(label, 4));
    await createQuestion(owner, ws.id, numberedMcq(label, 5));
    const explanation = `${label} 해설 비밀`;
    await owner.api.ok(
      'PATCH',
      `/questions/${first.id}`,
      { base_revision_id: first.revision.id, explanation },
      [200],
    );
    const viewer = await workspaceFactory.member(`${label}-viewer`);
    seedMembership(ws.id, viewer.user.id, 'viewer');
    // The third copy has the most graded attempts: it is the suggested keep (user decision).
    await answerCorrectly(owner, third);

    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(5);
    const dialog = await openDedup(page);
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/workspaces/${ws.id}` &&
        url.searchParams.getAll('panel').includes('question-duplicates'),
    );
    // One group of the three restyled copies; the most-practised one is kept by default (no
    // counts shown); no answers shown.
    const groups = dedupUi.groups(dialog);
    await expect(groups).toHaveCount(1);
    const group = groups.first();
    await expect(dedupUi.keep(group)).toHaveCount(3);
    await expect(dedupUi.keepNumber(group, 3)).toBeChecked();
    await expect(dedupUi.include(group)).toBeChecked();
    await expect(group).not.toContainText(/풀이 \d+|\d+ attempts?/i);
    await expect(dedupUi.warning(group)).toHaveCount(0);
    await expect(group).toContainText(`① ${DEDUP_TEXTS[0]}`);
    await expect(dialog).not.toContainText(explanation);

    // Keep the second, archive the other two.
    await dedupUi.keepNumber(group, 2).check();
    await expect(dedupUi.keepNumber(group, 2)).toBeChecked();
    await mergeSelected(page, dialog, 2);
    await expect(dedupUi.empty(dialog)).toBeVisible();
    // UX9: the Heatmap behind the modal dialog is hidden from assistive technology.
    await expect(homeBackgroundUi.dots(page)).toHaveCount(3);
    expect((await getQuestion(owner, first.id)).publication_status).toBe('ARCHIVED');
    expect((await getQuestion(owner, third.id)).publication_status).toBe('ARCHIVED');
    expect((await getQuestion(owner, second.id)).publication_status).toBe('CONFIRMED');
    // Scanning again finds nothing.
    expect((await scanDuplicates(owner, ws.id)).groups).toEqual([]);

    // The archived copies are in 보관·초안 문제 (보관됨).
    await dedupUi.close(dialog).click();
    await expect(dialog).toBeHidden();
    await expect(overviewUi.dots(page)).toHaveCount(3);
    await expect(overviewUi.dot(page, 2)).toBeVisible();
    await expect(overviewUi.dot(page, 1)).toHaveCount(0);
    await expect(overviewUi.dot(page, 3)).toHaveCount(0);
    await chooseQuestionMenu(page, 'inactive');
    const inactive = inactiveUi.dialog(page);
    await chooseFilter(page, inactiveUi.status(inactive), INACTIVE_STATUS_OPTIONS.archived);
    await expect(inactiveUi.rows(inactive)).toHaveCount(2);
    await page.reload();
    // Reloaded with 보관·초안 문제 open (modal): the Heatmap behind it.
    await expect(homeBackgroundUi.dots(page)).toHaveCount(3);

    // Viewer: the item is disabled with the reason, the URL opens nothing, the API refuses.
    for (const res of [
      await viewer.api.request('GET', `/workspaces/${ws.id}/question-duplicates`),
      await viewer.api.request('POST', `/workspaces/${ws.id}/question-duplicates/merge`, {
        groups: [{ keep_question_id: second.id, duplicate_question_ids: [first.id] }],
      }),
    ]) {
      expect(res.status).toBe(403);
      expect((res.body as Problem).type).toBe(PROBLEM_TYPES.insufficientRole);
    }
    await page.context().clearCookies();
    await signInAs(page, viewer.user);
    await page.goto(`${overviewPath(ws.id)}?panel=question-duplicates`);
    await expect(overviewUi.heatmap(page)).toBeVisible();
    await expect(dedupUi.dialog(page)).toHaveCount(0);
    await expectReadOnlyQuestionMenu(page, 'viewer');

    // Archived workspace: the same for the owner.
    await workspaceFactory.archive(owner, ws.id);
    const blocked = await owner.api.request('GET', `/workspaces/${ws.id}/question-duplicates`);
    expect(blocked.status).toBe(403);
    expect((blocked.body as Problem).type).toBe(PROBLEM_TYPES.workspaceArchived);
    await page.context().clearCookies();
    await signInAs(page, owner.user);
    await page.goto(`${overviewPath(ws.id)}?panel=question-duplicates`);
    await expect(overviewUi.heatmap(page)).toBeVisible();
    await expect(dedupUi.dialog(page)).toHaveCount(0);
    await expectReadOnlyQuestionMenu(page, 'archived');
  },
);

test(
  'QOV-01-AC17 the kept question shows the archived duplicate history merged in (latest grade, favorite union); clearing the favorite and unarchiving the duplicate unmerge it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(120_000);
    const label = 'qov01-ac17';
    const owner = await workspaceFactory.member(label);
    const ws = await workspaceFactory.create(owner);
    const kept = await createQuestion(owner, ws.id, dedupMcq(label, 1));
    const dup = await createQuestion(owner, ws.id, dedupMcq(label, 2, 'circled'));
    await answerCorrectly(owner, kept);
    const session = await startPractice(owner, dup.id);
    const correct = dup.revision.correct_option_ids ?? [];
    const wrong = dup.revision.options.find((o) => !correct.includes(o.id));
    if (!wrong) throw new Error('no wrong option');
    const graded = await submitPractice(owner, session.id, { selected_option_ids: [wrong.id] });
    expect(graded.result).toBe('incorrect');
    await setMyState(owner, dup.id, { is_favorite: true });
    const attemptsBefore = [
      ...(await listAttempts(owner, kept.id)),
      ...(await listAttempts(owner, dup.id)),
    ].map((a) => a.id);

    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await expect(overviewUi.dot(page, 1)).toHaveAttribute('data-status', 'correct');
    await expect(overviewUi.dot(page, 2)).toHaveAttribute('data-status', 'incorrect');
    const dialog = await openDedup(page);
    // One graded attempt each: the tie goes to the oldest (user decision 2026-11-01).
    await expect(dedupUi.keepNumber(dedupUi.groups(dialog).first(), 1)).toBeChecked();
    await mergeSelected(page, dialog, 1);
    await dedupUi.close(dialog).click();

    // One dot: the duplicate's later wrong answer and its favorite are the kept question's now.
    await expect(overviewUi.dots(page)).toHaveCount(1);
    const dot = overviewUi.dot(page, 1);
    await expect(dot).toHaveAttribute('data-status', 'incorrect');
    await expect(dot).toHaveAttribute('aria-label', /오답|incorrect/i);
    await expect(dot).toHaveAttribute('aria-label', /즐겨찾기|favorite/i);
    await expect(overviewUi.marker(dot)).toHaveAttribute('data-shape', 'star');
    await expect(overviewUi.marker(dot)).toHaveCSS('color', await statusColor(page, 'incorrect'));
    // Attempts are untouched: the kept question lists both, the same rows as before.
    const merged = await listAttempts(owner, kept.id);
    expect(merged.map((a) => a.id).sort()).toEqual([...attemptsBefore].sort());

    // Clearing the favorite on the kept question clears the merged one.
    await dot.click();
    const panel = panelUi.numbered(page, 1);
    await expect(panel).toBeVisible();
    await panelUi.favoriteOff(panel).click();
    await expect(panelUi.favoriteOn(panel)).toBeVisible();
    await panelUi.close(panel).click();
    await expect(overviewUi.marker(dot)).toHaveAttribute('data-shape', 'square');
    await page.reload();
    await expect(overviewUi.marker(overviewUi.dot(page, 1))).toHaveAttribute(
      'data-shape',
      'square',
    );

    // Unarchiving the duplicate unmerges it: each question shows its own record again.
    await chooseQuestionMenu(page, 'inactive');
    const inactive = inactiveUi.dialog(page);
    await chooseFilter(page, inactiveUi.status(inactive), INACTIVE_STATUS_OPTIONS.archived);
    await expect(inactiveUi.rows(inactive)).toHaveCount(1);
    await inactiveUi.restore(inactiveUi.rows(inactive).first()).click();
    await expect(homeBackgroundUi.dots(page)).toHaveCount(2);
    // UX9: the Heatmap is read once the modal dialog is closed.
    await inactiveUi.close(inactive).click();
    await expect(inactive).toBeHidden();
    await expect(overviewUi.dots(page)).toHaveCount(2);
    await expect(overviewUi.dot(page, 1)).toHaveAttribute('data-status', 'correct');
    await expect(overviewUi.dot(page, 2)).toHaveAttribute('data-status', 'incorrect');
    await expect(overviewUi.marker(overviewUi.dot(page, 2))).toHaveAttribute(
      'data-shape',
      'square',
    );
    expect(await listAttempts(owner, kept.id)).toHaveLength(1);
  },
);
