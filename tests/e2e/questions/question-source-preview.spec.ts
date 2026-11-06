// QSRC-01 — 문제 원문 보기: docs/screens/question-source-preview.md, docs/questions.md §16,
// docs/design-system.md §5.6. Contract half (QSRC-01-C01–C05):
// tests/integration/questions/source_region/.
//
// Each test signs in its own members and works in its own workspace. The questions come from the
// real import flow (questions-ko.pdf, drafts 1 and 5 registered), so their source rows carry the
// extractor's bbox; question 5 gets a second page-1 location (fixtures/question-source.ts S4). The
// answer key of the paper is on page 3 and never inside a region. Every API, DB and label
// assumption (S1–S7, the UI contract) is in the header of fixtures/question-source.ts. No LLM.
// QSRC.0 stays out of CI `E2E_PHASES` until QSRC-W.
//
// The viewer shows answers and explanations after a submission: traces, screenshots and videos are
// off, and shown text is checked with role/text assertions on synthetic strings only.
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expectAccessible } from '../fixtures/a11y.ts';
import { isMissingRoute, type ApiResponse } from '../fixtures/api.ts';
import { mockExamsPath, mockUi, questionRow } from '../fixtures/mock-exams.ts';
import { openRangePicker, questionAttemptCount, runUi } from '../fixtures/practice-runs.ts';
import {
  ANSWER_KEY_PAGE,
  ANSWER_KEY_TEXT,
  boxOf,
  correctText,
  displayedRatio,
  importLocations,
  isInert,
  longPress,
  touchPress,
  LONG_PRESS_MS,
  noHorizontalScroll,
  PAGE_HEIGHT_PT,
  panelByStem,
  pointOutside,
  ratio,
  requestMockSourceRegion,
  requestSourceRegion,
  seedQuestionSource,
  SINGLE_NUMBER,
  sourceUi,
  stemOf,
  TWO_PAGE_NUMBER,
  truth,
  unexpectedKeys,
  watchRegionTraffic,
  type SourceSeed,
} from '../fixtures/question-source.ts';
import {
  createShareLink,
  expect,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  sharedUi,
  ShareSession,
  test,
} from '../fixtures/sharing.ts';
import {
  choosePanelMenu,
  detailUi,
  homeUi,
  JOB_TIMEOUT_MS,
  overviewPath,
  panelUi,
  RESULT_TEXT,
  seedMembership,
  signInAs,
  type Member,
  type Question,
} from '../fixtures/test.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({
  storageState: { cookies: [], origins: [] },
  ...NO_VISUAL_ARTIFACTS,
  attachPageTextOnFailure: false,
  hasTouch: true,
});
test.describe.configure({ timeout: 3 * JOB_TIMEOUT_MS + 120_000 });

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 375, height: 812 };
const TABLET = { width: 820, height: 1180 };

function unique(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

/** Fails with a clear reason while the endpoint does not exist (RED evidence). */
function expectRoute(res: ApiResponse, what: string): void {
  expect(isMissingRoute(res), `${what} is implemented (got HTTP ${res.status})`).toBe(false);
}

async function openHome(page: Page, member: Member, workspaceId: string): Promise<void> {
  await signInAs(page, member.user);
  await page.goto(overviewPath(workspaceId));
  await expect(homeUi.questionMenuButton(page)).toBeVisible();
}

/** A stable snippet of the question's stem (the panel shows the stem, not the PDF text). */
function stemKey(q: Question): string {
  return stemOf(q)
    .replace(/^\s*\d+[.)]\s*/, '')
    .slice(0, 12);
}

/** Opens `?question=` for `q` and returns its panel (found by the stem). */
async function openQuestion(page: Page, workspaceId: string, q: Question): Promise<Locator> {
  await page.goto(overviewPath(workspaceId, q.id));
  const panel = page.getByRole('dialog').filter({ hasText: stemKey(q) });
  await expect(panel).toBeVisible();
  return panel;
}

async function submitCorrect(panel: Locator, n: number): Promise<void> {
  await panelUi.option(panel, correctText(n)).check();
  await panelUi.submit(panel).click();
  await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
}

async function seedViewer(
  workspaceFactory: WorkspaceFactory,
  s: SourceSeed,
  label: string,
): Promise<Member> {
  const member = await workspaceFactory.member(label);
  // fixtures/db.ts use 2: no membership API creates a viewer.
  seedMembership(s.workspaceId, member.user.id, 'viewer');
  return member;
}

test(
  'QSRC-01-AC01 the 문제 원문 보기 button shows on imported questions before and after submitting, not on manual or book-source questions, and fetches no PDF until used',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, unique('qsrc01-ac01'), { book: true });
    const traffic = watchRegionTraffic(page);
    await page.setViewportSize(DESKTOP);
    await openHome(page, s.owner, s.workspaceId);

    // Imported question 1: the button is there before submitting ...
    const panel = await openQuestion(page, s.workspaceId, s.single);
    await expect(sourceUi.button(panel)).toBeVisible();
    // ... and after (the same region response; nothing was submitted for it before).
    await submitCorrect(panel, SINGLE_NUMBER);
    await expect(sourceUi.button(panel)).toBeVisible();
    expect(traffic.statuses.get(s.single.id)).toBe(200);
    expect(unexpectedKeys(traffic.bodies.get(s.single.id)), 'no answer data in the region').toEqual(
      [],
    );
    await page.keyboard.press('Escape');

    // Imported question 5 (two pages).
    const second = await openQuestion(page, s.workspaceId, s.twoPage);
    await expect(sourceUi.button(second)).toBeVisible();
    await page.keyboard.press('Escape');

    // No import provenance: a manual question and a book-source question show no button.
    for (const q of [s.manual, s.bookOnly].flatMap((x) => (x ? [x] : []))) {
      const other = await openQuestion(page, s.workspaceId, q);
      await expect
        .poll(() => traffic.statuses.get(q.id), { message: 'the region request answered 404' })
        .toBe(404);
      await expect(sourceUi.button(other)).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
    expect(traffic.pdfRequests(), 'no PDF is fetched until the preview is used').toBe(0);

    // The question PDF is deleted: its questions stay, but there is no source any more.
    await s.owner.api.ok('DELETE', `/documents/${s.paperDocumentId}`, undefined, [200, 202, 204]);
    traffic.statuses.delete(s.single.id);
    const after = await openQuestion(page, s.workspaceId, s.single);
    await expect
      .poll(() => traffic.statuses.get(s.single.id), {
        message: 'region answered 404 after delete',
      })
      .toBe(404);
    await expect(sourceUi.button(after)).toHaveCount(0);
  },
);

test(
  'QSRC-01-AC02 hover, keyboard focus and a 500 ms long-press open the region tooltip; Escape and a tap outside close it without closing the panel; a short tap opens the dialog',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, unique('qsrc01-ac02'));
    await page.setViewportSize(DESKTOP);
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openQuestion(page, s.workspaceId, s.single);
    const button = sourceUi.button(panel);
    const tooltip = sourceUi.tooltip(page);
    await expect(button).toBeVisible();

    // Hover.
    await button.hover();
    await expect(tooltip).toBeVisible();
    await expect(sourceUi.figure(tooltip, 1)).toBeVisible();
    const tooltipId = await tooltip.getAttribute('id');
    expect(tooltipId, 'the tooltip has an id').toBeTruthy();
    await expect(button).toHaveAttribute('aria-describedby', new RegExp(`\\b${tooltipId}\\b`));
    await page.mouse.move(5, 5);
    await expect(tooltip).toBeHidden();

    // Keyboard focus; Escape closes only the tooltip.
    for (let i = 0; i < 40; i += 1) {
      if (await button.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(button).toBeFocused();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(sourceUi.dialog(page)).toHaveCount(0);

    // Long-press: the tooltip opens after 500 ms; letting go does not open the dialog.
    await page.mouse.move(5, 5);
    await longPress(page, button, LONG_PRESS_MS + 150);
    await expect(tooltip).toBeVisible();
    // The release click that follows a long-press is suppressed: give a wrong dialog time to open.
    await page.waitForTimeout(400);
    await expect(tooltip).toBeVisible();
    await expect(sourceUi.dialog(page)).toHaveCount(0);

    // A tap outside the tooltip (inside the panel) closes it; the panel stays.
    await panel.getByRole('heading').first().tap();
    await expect(tooltip).toBeHidden();
    await expect(panel).toBeVisible();

    // A short tap is a click: the dialog opens.
    await touchPress(page, button, 60);
    await expect(sourceUi.dialog(page)).toBeVisible();
  },
);

test(
  'QSRC-01-AC03 clicking the button opens the 문제 원문 dialog to the left of the question panel; Escape, 닫기 and the backdrop close only it and return focus to the button',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, unique('qsrc01-ac03'));
    await page.setViewportSize(DESKTOP);
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openQuestion(page, s.workspaceId, s.single);
    const stem = stemKey(s.single);
    await panelUi.option(panel, correctText(SINGLE_NUMBER)).check();
    const button = sourceUi.button(panel);
    const panelBefore = await boxOf(panel);
    const url = page.url();
    const attempts = questionAttemptCount(s.workspaceId);

    await button.click();
    const dialog = sourceUi.dialog(page);
    await expect(dialog).toBeVisible();
    // Side by side: the dialog is entirely left of the panel, both inside the viewport, panel kept.
    const box = await boxOf(dialog);
    const panelBox = await boxOf(panelByStem(page, stem));
    expect(box.x, 'dialog inside the viewport').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'dialog left of the panel').toBeLessThanOrEqual(panelBox.x + 1);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(DESKTOP.width);
    expect(panelBox.x).toBeCloseTo(panelBefore.x, 0);
    expect(panelBox.width).toBeCloseTo(panelBefore.width, 0);
    await expect(sourceUi.figures(dialog).first()).toBeVisible();
    expect(await isInert(panelByStem(page, stem)), 'the question panel is inert while open').toBe(
      true,
    );
    expect(page.url(), 'opening changes no URL').toBe(url);

    // Escape closes only the dialog; focus returns to the button; the answer is kept.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(button).toBeFocused();
    await expect(panelUi.option(panel, correctText(SINGLE_NUMBER))).toBeChecked();

    // 닫기.
    await button.click();
    await expect(dialog).toBeVisible();
    await sourceUi.close(dialog).click();
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();

    // Backdrop (left of the dialog, outside both).
    await button.click();
    await expect(dialog).toBeVisible();
    const outside = pointOutside(
      [await boxOf(dialog), await boxOf(panelByStem(page, stem))],
      DESKTOP,
    );
    await page.mouse.click(outside.x, outside.y);
    await expect(dialog).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(button).toBeFocused();

    // Escape twice: the dialog first, then the question panel.
    await button.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    expect(questionAttemptCount(s.workspaceId), 'viewing the source records no attempt').toBe(
      attempts,
    );
  },
);

test(
  'QSRC-01-AC04 on a 375px screen and on an 820px tablet the dialog is a full-screen sheet; 닫기, Escape and browser Back close only it and return to the question',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, unique('qsrc01-ac04'));
    await page.setViewportSize(PHONE);
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openQuestion(page, s.workspaceId, s.single);
    await panelUi.option(panel, correctText(SINGLE_NUMBER)).check();
    const button = sourceUi.button(panel);
    const url = page.url();
    const dialog = sourceUi.dialog(page);

    await button.tap();
    await expect(dialog).toBeVisible();
    const box = await boxOf(dialog);
    expect(box.x).toBeLessThanOrEqual(1);
    expect(box.y).toBeLessThanOrEqual(1);
    expect(box.width).toBeGreaterThanOrEqual(PHONE.width - 1);
    expect(box.height).toBeGreaterThanOrEqual(PHONE.height - 1);
    expect(await noHorizontalScroll(page), 'no horizontal scroll').toBe(true);
    await expectAccessible(page, 'QSRC-01 narrow sheet', { schemes: ['light'] });

    // Back closes only the sheet: the question panel and its URL stay.
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(panel).toBeVisible();
    expect(page.url()).toBe(url);
    await expect(panelUi.option(panel, correctText(SINGLE_NUMBER))).toBeChecked();

    // 닫기 and Escape.
    await button.tap();
    await expect(dialog).toBeVisible();
    await sourceUi.close(dialog).tap();
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();
    await button.tap();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(panel).toBeVisible();

    // A tablet too narrow for the panel plus a 320px dialog (< 868px) gets the same sheet.
    await page.setViewportSize(TABLET);
    await expect(panel).toBeVisible();
    await button.tap();
    await expect(dialog).toBeVisible();
    const wide = await boxOf(dialog);
    expect(wide.x).toBeLessThanOrEqual(1);
    expect(wide.width).toBeGreaterThanOrEqual(TABLET.width - 1);
    expect(wide.height).toBeGreaterThanOrEqual(TABLET.height - 1);
  },
);

test(
  'QSRC-01-AC05 the preview shows only the question region: the bbox aspect ratio, p.1 and p.2 stacked for a two-page question, no answer-key text, no page controls, and an answer-free region response',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, unique('qsrc01-ac05'));

    // The region API: documented keys only, one region per page, ascending.
    const single = await requestSourceRegion(s.owner, s.single.id);
    expectRoute(single, 'GET /questions/{id}/source-region');
    expect(single.status, 'source-region of an imported question').toBe(200);
    expect(unexpectedKeys(single.body), 'keys outside the documented shape').toEqual([]);
    const one = single.body?.regions ?? [];
    expect(one.map((r) => r.page)).toEqual([truth(SINGLE_NUMBER).page]);
    const first = one[0];
    if (!first) throw new Error('no region');
    expect(first.bbox.y1 - first.bbox.y0, 'a region, not a page').toBeLessThan(PAGE_HEIGHT_PT / 2);
    expect(one.map((r) => r.page)).not.toContain(ANSWER_KEY_PAGE);
    const stored = importLocations(s.single.id);
    expect(stored.length, 'the import stored a location with a bbox').toBeGreaterThan(0);
    const two = await requestSourceRegion(s.owner, s.twoPage.id);
    expect(two.status).toBe(200);
    expect(unexpectedKeys(two.body)).toEqual([]);
    const twoRegions = two.body?.regions ?? [];
    expect(twoRegions.map((r) => r.page)).toEqual([1, truth(TWO_PAGE_NUMBER).page]);

    // The UI: question 1.
    await page.setViewportSize(DESKTOP);
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openQuestion(page, s.workspaceId, s.single);
    await sourceUi.button(panel).click();
    const dialog = sourceUi.dialog(page);
    await expect(dialog).toBeVisible();
    await expect(sourceUi.figures(dialog)).toHaveCount(1);
    const figure = sourceUi.figure(dialog, 1);
    await expect(figure).toBeVisible();
    expect(await displayedRatio(figure)).toBeCloseTo(ratio(first.bbox), 1);
    await expect(sourceUi.figure(dialog, ANSWER_KEY_PAGE)).toHaveCount(0);
    await expect(dialog).not.toContainText(ANSWER_KEY_TEXT);
    await expect(sourceUi.forbiddenControls(dialog)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // The UI: question 5 spans two pages, stacked top to bottom as p.1 then p.2.
    const second = await openQuestion(page, s.workspaceId, s.twoPage);
    await sourceUi.button(second).click();
    await expect(dialog).toBeVisible();
    await expect(sourceUi.figures(dialog)).toHaveCount(2);
    const top = await boxOf(sourceUi.figure(dialog, 1));
    const bottom = await boxOf(sourceUi.figure(dialog, 2));
    expect(top.y + top.height, 'p.1 above p.2').toBeLessThanOrEqual(bottom.y + 1);
    const [r1, r2] = twoRegions;
    if (!r1 || !r2) throw new Error('missing regions');
    expect(await displayedRatio(sourceUi.figure(dialog, 1))).toBeCloseTo(ratio(r1.bbox), 1);
    expect(await displayedRatio(sourceUi.figure(dialog, 2))).toBeCloseTo(ratio(r2.bbox), 1);
    await expect(dialog).not.toContainText(ANSWER_KEY_TEXT);
    await expect(sourceUi.figure(dialog, ANSWER_KEY_PAGE)).toHaveCount(0);
  },
);

/** Moves a range-practice position forward without answering. */
async function advance(panel: Locator): Promise<void> {
  await runUi.next(panel).click();
}

test(
  'QSRC-01-AC06 the button is also in range practice, the 문제 상세 dialog and shuffle mock exam questions of imported questions, and never for manual questions, AI-varied mock questions or share guests',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, unique('qsrc01-ac06'), {
      book: true,
      mocks: true,
    });
    const { mockImported, mockManual, mockVaried } = s;
    if (!mockImported || !mockManual || !mockVaried) throw new Error('mock exams were not seeded');
    const viewer = await seedViewer(workspaceFactory, s, 'qsrc01-ac06-viewer');
    const link = await createShareLink(s.owner, s.workspaceId);

    // Routes first, so every "no button" below means "no region" and not "no route".
    const importedRegion = await requestSourceRegion(s.owner, s.single.id);
    expectRoute(importedRegion, 'GET /questions/{id}/source-region');
    expect(importedRegion.status).toBe(200);
    const mockRegion = await requestMockSourceRegion(s.owner, mockImported.question.id);
    expectRoute(mockRegion, 'GET /mock-exam-questions/{id}/source-region');
    expect(mockRegion.status, 'mock of an imported question').toBe(200);
    expect(unexpectedKeys(mockRegion.body)).toEqual([]);
    expect(mockRegion.body?.regions).toEqual(importedRegion.body?.regions);
    expect((await requestMockSourceRegion(s.owner, mockManual.question.id)).status).toBe(404);
    // An AI-varied mock question never has a region, even when its origin question does.
    expect((await requestMockSourceRegion(s.owner, mockVaried.question.id)).status).toBe(404);

    const traffic = watchRegionTraffic(page);
    await page.setViewportSize(DESKTOP);

    // Range practice (sequence(bank)): imported questions 1 and 5 have the button, manual ones not.
    await openHome(page, s.owner, s.workspaceId);
    let run = await openRangePicker(page);
    await runUi.selectAll(run).check();
    await runUi.start(run).click();
    await expect(page).toHaveURL(/[?&]practice=[0-9a-f-]{36}(&|$)/);
    run = runUi.panel(page);
    await expect(sourceUi.button(run)).toBeVisible();
    await sourceUi.button(run).click();
    await expect(sourceUi.dialog(page)).toBeVisible();
    await sourceUi.close(sourceUi.dialog(page)).click();
    await expect(sourceUi.dialog(page)).toHaveCount(0);
    await advance(run);
    await expect(sourceUi.button(run)).toBeVisible();
    await advance(run);
    await expect
      .poll(() => traffic.statuses.get(s.manual.id), { message: 'manual region answered 404' })
      .toBe(404);
    await expect(sourceUi.button(run)).toHaveCount(0);

    // 문제 상세 (manage) as a viewer: panel `문제 정보` › `정답·해설 보기`.
    await page.context().clearCookies();
    await openHome(page, viewer, s.workspaceId);
    const panel = await openQuestion(page, s.workspaceId, s.single);
    await choosePanelMenu(page, panel, 'answers');
    const detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    await expect(sourceUi.button(detail)).toBeVisible();
    await sourceUi.button(detail).click();
    await expect(sourceUi.dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sourceUi.dialog(page)).toHaveCount(0);
    await expect(detail).toBeVisible();

    // Mock exam questions: sequence(mock) and manage(mock) of the imported and the manual origin.
    await page.context().clearCookies();
    await openHome(page, s.owner, s.workspaceId);
    for (const mock of [mockImported, mockManual, mockVaried]) {
      const wantButton = mock === mockImported;
      await page.goto(mockExamsPath(s.workspaceId));
      const list = mockUi.dialog(page);
      await expect(list).toBeVisible();
      await mockUi.rowTitle(mockUi.row(list, mock.title)).click();
      const mockPanel = mockUi.practicePanel(page);
      await expect(mockUi.practiceTitle(mockPanel, mock.title)).toBeVisible();
      await runUi.start(mockPanel).click();
      await expect(runUi.mockTitle(mockPanel, 1)).toBeVisible();
      if (wantButton) {
        await expect(sourceUi.button(mockPanel)).toBeVisible();
        await sourceUi.button(mockPanel).click();
        await expect(sourceUi.dialog(page)).toBeVisible();
        await page.keyboard.press('Escape');
      } else {
        await expect
          .poll(() => traffic.statuses.get(mock.question.id), { message: 'mock region 404' })
          .toBe(404);
        await expect(sourceUi.button(mockPanel)).toHaveCount(0);
      }
      await page.goto(mockExamsPath(s.workspaceId));
      await mockUi.openDetail(mockUi.row(mockUi.dialog(page), mock.title), mock.title);
      await questionRow(mockUi.dialog(page), 1).click();
      const viewerPanel = mockUi.viewer(page, 1);
      await expect(viewerPanel).toBeVisible();
      if (wantButton) await expect(sourceUi.button(viewerPanel)).toBeVisible();
      else await expect(sourceUi.button(viewerPanel)).toHaveCount(0);
    }

    // Share guest: no button, no region request, and the API refuses the guest.
    await page.context().clearCookies();
    const guestTraffic = watchRegionTraffic(page);
    await openShareWithSecret(page, link.id, link.secret);
    await sharedUi.question(page, stemKey(s.single)).click();
    const shared = sharedUi.questionPanel(page);
    await expect(shared).toBeVisible();
    await expect(shared).toContainText(stemKey(s.single));
    await expect(sourceUi.button(shared)).toHaveCount(0);
    expect(guestTraffic.regionRequests(), 'a guest never asks for a region').toBe(0);
    const guest = await ShareSession.open(link.id, link.secret);
    const refused = await guest.call('GET', `/questions/${s.single.id}/source-region`);
    expect([401, 403, 404], 'the guest session cannot use the member API').toContain(
      refused.status,
    );
    expect(page.url()).toContain(link.id);
  },
);
