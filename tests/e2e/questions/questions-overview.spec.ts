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
  createNumberedQuestions,
  draftFor,
  expect,
  getOverview,
  importPaperDrafts,
  JOB_TIMEOUT_MS,
  listAttempts,
  overviewItem,
  overviewPath,
  overviewUi,
  panelUi,
  publishDrafts,
  questionPaper,
  scaleOf,
  setMyState,
  signInAs,
  startPractice,
  statusColor,
  test,
  truthQuestion,
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
    await expect(overviewUi.summary(page)).toContainText(/전체\s*100|total\s*100/i);

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
