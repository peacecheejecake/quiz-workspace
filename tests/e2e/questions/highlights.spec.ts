// HILITE-01 — 하이라이트 (공통 하이라이트 도구 · 내 하이라이트), docs/screens/highlights.md; rules
// docs/questions.md §15, design-system §5.2. Contract half (C01–C08):
// tests/integration/questions/highlights/.
//
// Each test uploads the synthetic book-ko.pdf into its own workspace, creates CONFIRMED MCQs with
// explanations in "1장 물의 순환" and makes chapter notes with the APP_ENV=test scenario LLM
// (E2E-NOTE-OK items "… 핵심 용어를 묻는다. NOTE-OK-A" / "… 과정의 순서를 묻는다. NOTE-OK-B" /
// "… 개념과 순서가 이어진다. NOTE-OK-C"). Highlights a test does not create through the UI are created
// through the public my-highlights API (assumptions H1–H5 and the UI contract in the
// tests/e2e/fixtures/highlights.ts header). Notes and explanations carry answers: traces,
// screenshots and videos are off and no page text is attached on failure.
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import {
  generateNote,
  getNote,
  noteUi,
  notePanelPath,
  sharedNotePanelPath,
} from '../fixtures/chapter-notes.ts';
import { assignChapters } from '../fixtures/chapter-redistribution.ts';
import {
  CH1,
  chapterHighlights,
  chooseColor,
  chooseRowItem,
  COLOR_UNDERLINE,
  copiedTexts,
  dragSelect,
  highlightExplanation,
  highlightKeysIn,
  highlightNote,
  highlightRequest,
  highlightRowCount,
  highlightUi,
  isOnTop,
  itemText,
  markStyle,
  noteSetup,
  pressUntilFocused,
  recordClipboard,
  chosenText,
  selectionRect,
  selectionText,
  touchSelect,
  type HighlightColor,
  type NoteSetup,
} from '../fixtures/highlights.ts';
import {
  createShareLink,
  expect,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  ShareSession,
  startFork,
  test,
  waitForFork,
} from '../fixtures/sharing.ts';
import {
  archiveQuestion,
  choosePanelMenu,
  detailUi,
  outlineNodeId,
  overviewPath,
  overviewUi,
  panelUi,
  PROBLEM_TYPES,
  seedMembership,
  signInAs,
  JOB_TIMEOUT_MS,
  type Member,
  type Problem,
  type Question,
} from '../fixtures/test.ts';
import type { FakeTurnstile } from '../fixtures/turnstile.ts';

test.use({
  storageState: { cookies: [], origins: [] },
  ...NO_VISUAL_ARTIFACTS,
  attachPageTextOnFailure: false,
});
test.describe.configure({ timeout: 6 * JOB_TIMEOUT_MS });

const PHRASE_A = '핵심 용어';
const PHRASE_B = '과정의 순서';
const PHRASE_C = '두 문제를 함께';
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

async function openPanel(page: Page, workspaceId: string, chapterId: string): Promise<Locator> {
  await page.goto(notePanelPath(workspaceId, chapterId));
  const panel = noteUi.panel(page);
  await expect(panel).toBeVisible();
  return panel;
}

async function switchUser(page: Page, user: Member): Promise<void> {
  await page.context().clearCookies();
  await signInAs(page, user.user);
}

async function newSignedInPage(
  browser: Browser,
  turnstile: FakeTurnstile,
  user: Member,
  options: Parameters<Browser['newContext']>[0] = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    reducedMotion: 'reduce',
    storageState: { cookies: [], origins: [] },
    ...options,
  });
  await turnstile.install(context);
  const page = await context.newPage();
  await signInAs(page, user.user);
  return { context, page };
}

/** The mark is styled as `color`: a background and the color's underline shape. */
async function expectMarkColor(mark: Locator, color: HighlightColor): Promise<void> {
  await expect(mark).toHaveAttribute('data-highlight-color', color);
  await expect(mark).toContainText(highlightUi.startLabel(color));
  const style = await markStyle(mark);
  expect(style.background, 'a highlight has a background').not.toBe(TRANSPARENT);
  expect(style.line).toContain('underline');
  expect(style.style, `${color} underline shape`).toBe(COLOR_UNDERLINE[color]);
}

/** Opens the practice panel of `question` from the heatmap and submits option 1 (correct). */
async function submitFromHeatmap(page: Page, s: NoteSetup, n: number): Promise<Locator> {
  await page.goto(overviewPath(s.workspaceId));
  await overviewUi.dot(page, n).click();
  const panel = panelUi.numbered(page, n);
  await expect(panel).toBeVisible();
  await panelUi.option(panel, `${s.label}-${n} 보기 가`).check();
  await panelUi.submit(panel).click();
  await expect(panelUi.result(panel)).toBeVisible();
  return panel;
}

/**
 * `chooseColor`, then waits for the highlight write: a navigation right after the menu closes
 * would otherwise abort the request still in flight (under a loaded parallel run).
 */
async function chooseColorSaved(page: Page, color: HighlightColor): Promise<void> {
  const saved = page.waitForResponse(
    (r) =>
      /\/my-highlights(\/[^/]+)?$/.test(new URL(r.url()).pathname) &&
      ['POST', 'PATCH'].includes(r.request().method()),
  );
  await chooseColor(page, color);
  expect((await saved).ok(), 'the highlight is saved').toBe(true);
}

function q(s: NoteSetup, n: number): Question {
  const found = s.questions[n - 1];
  if (!found) throw new Error(`no question ${n}`);
  return found;
}

test(
  'HILITE-01-AC01 selecting note text shows the highlight menu; a highlight is saved per user and visible on every device of that user only',
  { tag: '@infra' },
  async ({ page, browser, turnstile, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, 'hilite01-ac01');
    const viewer = await workspaceFactory.member('hilite01-ac01-viewer');
    seedMembership(s.workspaceId, viewer.user.id, 'viewer');

    await signInAs(page, s.owner.user);
    let panel = await openPanel(page, s.workspaceId, s.ch1);
    let body = highlightUi.noteBody(panel);
    await expect(body).toBeVisible();
    await dragSelect(body, PHRASE_A);
    const menu = highlightUi.menu(page);
    await expect(menu).toBeVisible();
    await expect(menu.locator('[role^="menuitem"]')).toHaveCount(4);
    for (const color of ['yellow', 'blue', 'pink'] as const) {
      await expect(highlightUi.colorItem(menu, color)).toBeVisible();
    }
    await expect(highlightUi.copyItem(menu)).toBeVisible();
    await expect(highlightUi.removeItem(menu)).toHaveCount(0);
    // The menu sits above the selection.
    // Placed next to the selection (above, or below without room), never over it.
    const menuBox = await menu.boundingBox();
    const sel = await selectionRect(page);
    expect(menuBox, 'the menu is laid out').not.toBeNull();
    if (menuBox) {
      const above = menuBox.y + menuBox.height <= sel.top + 1;
      const below = menuBox.y >= sel.bottom - 1;
      expect(above || below, 'the menu does not cover the selection').toBe(true);
    }
    await chooseColor(page, 'yellow');

    const mark = highlightUi.markWith(body, PHRASE_A);
    await expect(mark).toHaveCount(1);
    await expectMarkColor(mark, 'yellow');
    const section = highlightUi.section(panel);
    await expect(highlightUi.heading(section, 1)).toBeVisible();
    await expect(highlightUi.onlyMine(section)).toBeVisible();
    await expect(
      highlightUi.row(section, highlightUi.rowMeta('yellow', 'note', '버전 1')),
    ).toHaveCount(1);

    // A reload and A's second device show the same highlight.
    await page.reload();
    panel = noteUi.panel(page);
    body = highlightUi.noteBody(panel);
    await expect(highlightUi.markWith(body, PHRASE_A)).toHaveCount(1);
    const second = await newSignedInPage(browser, turnstile, s.owner);
    try {
      const other = await openPanel(second.page, s.workspaceId, s.ch1);
      await expect(highlightUi.markWith(highlightUi.noteBody(other), PHRASE_A)).toHaveCount(1);
      await expect(highlightUi.heading(highlightUi.section(other), 1)).toBeVisible();
    } finally {
      await second.context.close();
    }

    // The viewer B sees none of it and cannot touch it.
    const [own] = await chapterHighlights(s.owner, s.ch1);
    if (!own) throw new Error('the owner has one highlight');
    await switchUser(page, viewer);
    panel = await openPanel(page, s.workspaceId, s.ch1);
    await expect(highlightUi.marks(highlightUi.noteBody(panel))).toHaveCount(0);
    await expect(highlightUi.heading(highlightUi.section(panel), 0)).toBeVisible();
    const listed = await chapterHighlights(viewer, s.ch1);
    expect(listed.map((h) => h.id)).not.toContain(own.id);
    const patch = await highlightRequest(viewer, 'PATCH', `/my-highlights/${own.id}`, {
      color: 'blue',
      version: own.version,
    });
    const del = await highlightRequest(viewer, 'DELETE', `/my-highlights/${own.id}`);
    expect([patch.status, del.status]).toEqual([404, 404]);
    expect((await chapterHighlights(s.owner, s.ch1)).map((h) => [h.id, h.color])).toEqual([
      [own.id, 'yellow'],
    ]);
  },
);

test(
  'HILITE-01-AC02 overlapping colors merge, a click recolors, remove deletes whole highlights, copy copies plain text, Escape keeps the selection, cross-paragraph selections are refused',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, 'hilite01-ac02');
    await highlightNote(s.owner, s.note, 0, 0, PHRASE_A, 'yellow');
    await recordClipboard(page);
    await signInAs(page, s.owner.user);
    const panel = await openPanel(page, s.workspaceId, s.ch1);
    const body = highlightUi.noteBody(panel);
    const section = highlightUi.section(panel);
    await expect(highlightUi.markWith(body, PHRASE_A)).toHaveCount(1);

    // A longer selection overlapping the yellow one + 파랑 → one merged blue highlight.
    await dragSelect(body, '이 장의', '핵심');
    await chooseColor(page, 'blue');
    await expect(highlightUi.marks(body)).toHaveCount(1);
    const merged = highlightUi.marks(body).first();
    await expect(merged).toContainText(`이 장의 ${PHRASE_A}`);
    await expectMarkColor(merged, 'blue');
    await expect(highlightUi.marksOf(body, 'yellow')).toHaveCount(0);
    await expect(highlightUi.heading(section, 1)).toBeVisible();

    // Clicking it (no selection) opens the same menu with 파랑 checked; 분홍 recolors only.
    await merged.click();
    let menu = highlightUi.menu(page);
    await expect(highlightUi.colorItem(menu, 'blue')).toHaveAttribute('aria-checked', 'true');
    await chooseColor(page, 'pink');
    await expectMarkColor(highlightUi.marks(body).first(), 'pink');
    await expect(highlightUi.marks(body).first()).toContainText(`이 장의 ${PHRASE_A}`);

    // Removing from a selection inside it deletes the whole highlight.
    await dragSelect(body, '용어');
    menu = highlightUi.menu(page);
    await highlightUi.removeItem(menu).click();
    await expect(highlightUi.marks(body)).toHaveCount(0);
    await expect(highlightUi.heading(section, 0)).toBeVisible();

    // Copy: the selected text only (no hidden labels, no footnote numbers).
    await dragSelect(body, PHRASE_B);
    menu = highlightUi.menu(page);
    await highlightUi.copyItem(menu).click();
    // The menu closes, the selection goes and the toast shows over the modal panel.
    await expect(menu).toBeHidden();
    await expect(highlightUi.copiedToast(page)).toBeVisible();
    await expect.poll(() => isOnTop(highlightUi.copiedToast(page))).toBe(true);
    await expect.poll(() => selectionText(page)).toBe('');
    expect(await copiedTexts(page)).toEqual([PHRASE_B]);

    // Escape closes the menu, keeps the selection and returns focus to the note body.
    await dragSelect(body, PHRASE_B);
    await expect(highlightUi.menu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(highlightUi.menu(page)).toBeHidden();
    await expect(noteUi.panel(page)).toBeVisible();
    expect(await selectionText(page)).toContain(PHRASE_B);
    // Radix returns focus on a timer after the unmount: about 7ms on Chromium, with focus on <body>.
    await expect.poll(() => body.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    // A selection across two items: color items disabled with the reason as text.
    await dragSelect(body, PHRASE_A, PHRASE_B);
    menu = highlightUi.menu(page);
    await expect(menu).toBeVisible();
    for (const color of ['yellow', 'blue', 'pink'] as const) {
      await expect(highlightUi.colorItem(menu, color)).toHaveAttribute('aria-disabled', 'true');
    }
    await expect(highlightUi.oneBlockReason(page)).toBeVisible();
    expect(await chapterHighlights(s.owner, s.ch1)).toHaveLength(0);
  },
);

test(
  'HILITE-01-AC03 an explanation highlight made after submitting appears in the chapter note panel and in the question details, never before submission',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, 'hilite01-ac03', { count: 1, versions: 0 });
    const highlightCalls: string[] = [];
    // The practice panel opens and submits its session through server actions (POST with a
    // `next-action` header, RSC payload) — or the `/api/.../practice-sessions` relay: every such
    // response body is read as text and must not mention highlights.
    const practiceBodies: string[] = [];
    page.on('request', (req) => {
      if (/my-highlights/.test(req.url())) highlightCalls.push(req.method());
    });
    page.on('response', async (res) => {
      const req = res.request();
      if (req.method() !== 'POST') return;
      const action = (await req.headerValue('next-action')) !== null;
      if (!action && !/practice-sessions/.test(res.url())) return;
      practiceBodies.push(await res.text().catch(() => ''));
    });

    await signInAs(page, s.owner.user);
    await page.goto(overviewPath(s.workspaceId));
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await expect(panel).toBeVisible();
    await expect(highlightUi.explanation(panel)).toHaveCount(0);
    expect(highlightCalls, 'no highlight request before submission').toEqual([]);
    await panelUi.option(panel, `${s.label}-1 보기 가`).check();
    await panelUi.submit(panel).click();
    const explanation = highlightUi.explanation(panel);
    await expect(explanation).toBeVisible();
    await expect.poll(() => practiceBodies.length).toBeGreaterThan(0);
    for (const body of practiceBodies) expect(body).not.toMatch(/highlight/i);
    // The practice API itself (what the server action relays) has no highlight field either.
    const session = await s.owner.api.ok<{ id: string; options: { id: string }[] }>(
      'POST',
      `/questions/${q(s, 1).id}/practice-sessions`,
      {},
      [201],
    );
    const submitted = await s.owner.api.ok<unknown>(
      'POST',
      `/practice-sessions/${session.id}/submit`,
      { selected_option_ids: [session.options[0]?.id ?? ''] },
      [200],
    );
    expect([...highlightKeysIn(session), ...highlightKeysIn(submitted)]).toEqual([]);

    await dragSelect(explanation, '첫 번째 보기가');
    await chooseColor(page, 'pink');
    const mark = highlightUi.markWith(explanation, '첫 번째 보기가');
    await expect(mark).toHaveCount(1);
    await expectMarkColor(mark, 'pink');
    // The toast replaced the text under the explanation; it shows over the panel.
    await expect(highlightUi.collectedToast(page)).toContainText(CH1);
    await expect.poll(() => isOnTop(highlightUi.collectedToast(page))).toBe(true);
    await expect(
      panel.getByText(/정리 노트의 내 하이라이트에 모았습니다|added to my highlights/i),
    ).toHaveCount(0);

    // The chapter has no AI note, yet its panel lists the highlight under 내 하이라이트.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await noteUi.opener(noteUi.group(page, CH1), CH1).click();
    const note = noteUi.panel(page);
    await expect(noteUi.empty(note)).toBeVisible();
    const section = highlightUi.section(note);
    await expect(highlightUi.heading(section, 1)).toBeVisible();
    const row = highlightUi.row(section, highlightUi.rowMeta('pink', 'explanation', '1번'));
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('첫 번째 보기가');
    await expect(row).toContainText(/\[\^h1\]\s*1번\s*[—–-]\s*\S/);

    // The "문제 상세" dialog shows the same highlight in its explanation.
    await page.goto(overviewPath(s.workspaceId, q(s, 1).id));
    const reopened = panelUi.numbered(page, 1);
    await expect(reopened).toBeVisible();
    await panelUi.reveal(reopened).click();
    await expect(highlightUi.explanation(reopened)).toBeVisible();
    await choosePanelMenu(page, reopened, 'answers');
    const detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    await expect(
      highlightUi.markWith(highlightUi.explanation(detail), '첫 번째 보기가'),
    ).toHaveCount(1);
  },
);

test(
  'HILITE-01-AC04 내 하이라이트 filters by color and source, keeps the version-then-Heatmap order, moves to a highlight, recolors and deletes by keyboard',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, 'hilite01-ac04', { count: 2 });
    const v1 = s.note;
    await highlightNote(s.owner, v1, 0, 1, PHRASE_B, 'blue'); // previous version after v2
    const v2 = await generateNote(s.owner, s.ch1);
    await highlightNote(s.owner, v2, 0, 0, PHRASE_A, 'yellow');
    await highlightNote(s.owner, v2, 0, 1, PHRASE_B, 'blue');
    await highlightExplanation(s.owner, q(s, 1), '첫 번째 보기가', 'pink');
    await highlightExplanation(s.owner, q(s, 2), '보기가 맞다', 'yellow');

    await signInAs(page, s.owner.user);
    const panel = await openPanel(page, s.workspaceId, s.ch1);
    const section = highlightUi.section(panel);
    await expect(highlightUi.heading(section, 5)).toBeVisible();
    const rows = highlightUi.rows(section);
    await expect(rows).toHaveCount(5);
    // Order: current version (body order) → previous version → explanations (Heatmap order).
    const metas = [
      highlightUi.rowMeta('yellow', 'note', '버전 2'),
      highlightUi.rowMeta('blue', 'note', '버전 2'),
      highlightUi.rowMeta('blue', 'note', '버전 1'),
      highlightUi.rowMeta('pink', 'explanation', '1번'),
      highlightUi.rowMeta('yellow', 'explanation', '2번'),
    ];
    for (const [i, meta] of metas.entries()) await expect(rows.nth(i)).toContainText(meta);
    await expect(
      section.getByRole('link', { name: /전체 하이라이트|모든 하이라이트|all highlights/i }),
    ).toHaveCount(0);

    // Filters, by keyboard; chips report their state with aria-pressed.
    const yellow = highlightUi.colorChip(section, 'yellow');
    await yellow.focus();
    await page.keyboard.press('Enter');
    await expect(yellow).toHaveAttribute('aria-pressed', 'true');
    await expect(rows).toHaveCount(2);
    const explanationChip = highlightUi.sourceChip(section, '해설');
    await explanationChip.focus();
    await page.keyboard.press('Enter');
    await expect(explanationChip).toHaveAttribute('aria-pressed', 'true');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(metas[4] as RegExp);
    for (const chip of [
      highlightUi.colorChip(section, '전체'),
      highlightUi.sourceChip(section, '전체'),
    ]) {
      await chip.focus();
      await page.keyboard.press('Enter');
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(rows).toHaveCount(5);

    // 위치로 이동 on the previous-version row switches to version 1 and focuses its mark.
    await chooseRowItem(page, rows.nth(2), 'goto', true);
    await expect
      .poll(() => chosenText(noteUi.version(panel)))
      .toMatch(/^(버전|version)\s*1(?!\d)/i);
    await expect(noteUi.previousNotice(panel)).toBeVisible();
    const v1Mark = highlightUi.markWith(highlightUi.noteBody(panel), PHRASE_B);
    await expect(v1Mark).toBeFocused();

    // 위치로 이동 on an explanation row stacks "문제 상세" over the note, focused on the mark.
    const explanationRow = rows.nth(3);
    const rowButton = highlightUi.rowMenuButton(explanationRow);
    await chooseRowItem(page, explanationRow, 'goto', true);
    const detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    await expect(noteUi.panel(page)).toBeAttached();
    await expect(
      highlightUi.markWith(highlightUi.explanation(detail), '첫 번째 보기가'),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();
    await expect(rowButton).toBeFocused();

    // 색 바꾸기 › 파랑 on the first row (keyboard), kept after a reload.
    await chooseRowItem(page, rows.first(), 'recolor', true);
    const blue = page
      .getByRole('menuitemradio', { name: /^(파랑|blue)$/i })
      .or(page.getByRole('menuitem', { name: /^(파랑|blue)$/i }));
    await expect(blue).toBeVisible();
    await pressUntilFocused(page, blue);
    await page.keyboard.press('Enter');
    await expect(rows.first()).toContainText(highlightUi.rowMeta('blue', 'note', '버전'));
    await page.reload();
    const reloaded = highlightUi.section(noteUi.panel(page));
    await expect(highlightUi.rows(reloaded).first()).toContainText(
      highlightUi.rowMeta('blue', 'note', '버전 2'),
    );
    await expect(
      highlightUi.marksOf(highlightUi.noteBody(noteUi.panel(page)), 'yellow'),
    ).toHaveCount(0);

    // 삭제 (keyboard): no confirmation, the row and its mark go, the deletion is announced.
    const second = highlightUi.rows(reloaded).nth(1);
    await chooseRowItem(page, second, 'delete', true);
    await expect(highlightUi.rows(reloaded)).toHaveCount(4);
    await expect(highlightUi.deletedToast(page)).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(highlightUi.marks(highlightUi.noteBody(noteUi.panel(page)))).toHaveCount(1);
  },
);

test(
  'HILITE-01-AC05 note highlights stay with their version; explanation highlights relocate, go missing, follow moved questions and hide while archived',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, 'hilite01-ac05', {
      count: 2,
      input: (n) => (n === 1 ? { explanation: '가나다 라마바 사아자' } : {}),
    });
    await highlightExplanation(s.owner, q(s, 1), '라마바', 'yellow');
    await highlightExplanation(s.owner, q(s, 2), '첫 번째 보기가', 'pink');
    await highlightNote(s.owner, s.note, 0, 0, PHRASE_A, 'blue');

    // 다시 만들기 → version 2 has no highlight; the note row says 버전 1; both explanation rows stay.
    await generateNote(s.owner, s.ch1);
    await signInAs(page, s.owner.user);
    let panel = await openPanel(page, s.workspaceId, s.ch1);
    await expect(highlightUi.marks(highlightUi.noteBody(panel))).toHaveCount(0);
    let section = highlightUi.section(panel);
    await expect(highlightUi.rows(section)).toHaveCount(3);
    await expect(
      highlightUi.row(section, highlightUi.rowMeta('blue', 'note', '버전 1')),
    ).toHaveCount(1);

    // An edit before the quote: the highlight is found again in place.
    const editPrefix = await s.owner.api.ok<Question>(
      'PATCH',
      `/questions/${q(s, 1).id}`,
      { base_revision_id: q(s, 1).revision.id, explanation: '가나다 (보충) 라마바 사아자' },
      [200],
    );
    await page.goto(overviewPath(s.workspaceId, q(s, 1).id));
    let play = panelUi.numbered(page, 1);
    await choosePanelMenu(page, play, 'answers');
    let detail = detailUi.dialog(page);
    await expect(highlightUi.markWith(highlightUi.explanation(detail), '라마바')).toHaveCount(1);
    const relocated = (await chapterHighlights(s.owner, s.ch1)).find((h) => h.quote === '라마바');
    expect(relocated?.anchor_status).toBe('relocated');

    // The quote is deleted: no mark; the row keeps the quote with the badge, 위치로 이동 disabled.
    await s.owner.api.ok(
      'PATCH',
      `/questions/${q(s, 1).id}`,
      { base_revision_id: editPrefix.revision.id, explanation: '가나다 (보충) 사아자' },
      [200],
    );
    await page.goto(overviewPath(s.workspaceId, q(s, 1).id));
    play = panelUi.numbered(page, 1);
    await choosePanelMenu(page, play, 'answers');
    detail = detailUi.dialog(page);
    await expect(highlightUi.explanation(detail)).toBeVisible();
    await expect(highlightUi.marks(highlightUi.explanation(detail))).toHaveCount(0);
    panel = await openPanel(page, s.workspaceId, s.ch1);
    section = highlightUi.section(panel);
    const missing = highlightUi.row(section, '라마바');
    await expect(highlightUi.missingBadge(missing)).toBeVisible();
    await highlightUi.rowMenuButton(missing).click();
    await expect(highlightUi.rowMenuItem(page, 'goto')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');

    // Q2 moves to 2장 (챕터 재분배): its highlight leaves 1장 and shows in 2장.
    const moved = await assignChapters(s.owner, s.workspaceId, {
      source: 'manual',
      items: [{ question_id: q(s, 2).id, chapter_id: s.ch2, expected_chapter_id: s.ch1 }],
    });
    expect(moved.status).toBe(200);
    panel = await openPanel(page, s.workspaceId, s.ch1);
    await expect(highlightUi.row(highlightUi.section(panel), '첫 번째 보기가')).toHaveCount(0);
    panel = await openPanel(page, s.workspaceId, s.ch2);
    await expect(highlightUi.row(highlightUi.section(panel), '첫 번째 보기가')).toHaveCount(1);

    // Archived Q1: hidden from 1장; unarchived: back.
    const current = await s.owner.api.ok<Question>(
      'GET',
      `/questions/${q(s, 1).id}`,
      undefined,
      [200],
    );
    const archived = await archiveQuestion(s.owner, current);
    panel = await openPanel(page, s.workspaceId, s.ch1);
    await expect(highlightUi.row(highlightUi.section(panel), '라마바')).toHaveCount(0);
    await s.owner.api.ok(
      'PATCH',
      `/questions/${q(s, 1).id}`,
      { base_revision_id: archived.revision.id, publication_status: 'CONFIRMED' },
      [200],
    );
    panel = await openPanel(page, s.workspaceId, s.ch1);
    await expect(highlightUi.row(highlightUi.section(panel), '라마바')).toHaveCount(1);
  },
);

test(
  'HILITE-01-AC06 viewers and archived workspaces highlight (with undo); guests and forks never see highlights; the keyboard highlights a whole paragraph',
  { tag: '@infra' },
  async ({ page, browser, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, 'hilite01-ac06', { count: 2 });
    const viewer = await workspaceFactory.member('hilite01-ac06-viewer');
    seedMembership(s.workspaceId, viewer.user.id, 'viewer');
    await highlightNote(s.owner, s.note, 1, 0, '개념과 순서', 'pink'); // the owner's own

    // V highlights the note and a submitted explanation and manages them.
    await signInAs(page, viewer.user);
    let panel = await openPanel(page, s.workspaceId, s.ch1);
    await dragSelect(highlightUi.noteBody(panel), PHRASE_A);
    await chooseColorSaved(page, 'yellow');
    const play = await submitFromHeatmap(page, s, 1);
    await dragSelect(highlightUi.explanation(play), '첫 번째 보기가');
    await chooseColorSaved(page, 'blue');
    panel = await openPanel(page, s.workspaceId, s.ch1);
    let section = highlightUi.section(panel);
    await expect(highlightUi.heading(section, 2)).toBeVisible();
    await chooseRowItem(page, highlightUi.rows(section).first(), 'delete');
    await expect(highlightUi.heading(section, 1)).toBeVisible();

    // Keyboard: Tab into the body, ArrowDown to the second item, Shift+F10 → whole paragraph.
    await switchUser(page, s.owner);
    panel = await openPanel(page, s.workspaceId, s.ch1);
    const body = highlightUi.noteBody(panel);
    for (
      let i = 0;
      i < 30 && !(await body.evaluate((el) => el.contains(document.activeElement)));
      i++
    ) {
      await page.keyboard.press('Tab');
    }
    expect(await body.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+F10');
    await expect(highlightUi.menu(page)).toBeVisible();
    await expect(highlightUi.colorItem(highlightUi.menu(page), 'yellow')).toBeFocused();
    await page.keyboard.press('Enter');
    const whole = itemText(s.note, 0, 1);
    await expect
      .poll(async () => (await chapterHighlights(s.owner, s.ch1)).map((h) => h.quote))
      .toContain(whole);

    // Guest: no menu, no marks, no 내 하이라이트; the shared API has no highlight fields.
    const link = await createShareLink(s.owner, s.workspaceId, { allow_fork: true });
    const session = await ShareSession.open(link.id, link.secret);
    const guestContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const guest = await guestContext.newPage();
      await openShareWithSecret(guest, link.id, link.secret);
      // The fragment is exchanged for the share session first (the card lists the note).
      await expect(noteUi.sharedChapter(noteUi.sharedCard(guest), CH1)).toBeVisible();
      await guest.goto(sharedNotePanelPath(link.id, s.ch1));
      const shared = noteUi.panel(guest);
      await expect(shared).toBeVisible();
      const sharedBody = shared.getByRole('listitem').filter({ hasText: 'NOTE-OK-A' }).first();
      await dragSelect(sharedBody, PHRASE_A);
      await expect(highlightUi.menu(guest)).toHaveCount(0);
      await expect(shared.locator('mark[data-highlight-color]')).toHaveCount(0);
      await expect(highlightUi.section(shared)).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
    for (const path of ['', `/chapters/${s.ch1}/note`, '/questions']) {
      const res = await session.get(path);
      expect(res.status, `shared ${path || 'workspace'}`).toBe(200);
      expect(highlightKeysIn(res.body), `shared ${path || 'workspace'}`).toEqual([]);
    }

    // Fork: the copy holds no highlight of anyone.
    const recipient = await workspaceFactory.member('hilite01-ac06-recipient');
    const fork = await startFork(recipient, session, 'hilite fork');
    const done = await waitForFork(recipient, fork.id, 'COMPLETED');
    const target = done.target_workspace_id ?? '';
    expect(highlightRowCount(target)).toBe(0);
    const docs = await recipient.api.ok<{ items: { id: string }[] }>(
      'GET',
      `/workspaces/${target}/documents`,
      undefined,
      [200],
    );
    const forkedCh1 = await outlineNodeId(recipient, docs.items[0]?.id ?? '', CH1);
    await switchUser(page, recipient);
    panel = await openPanel(page, target, forkedCh1);
    await expect(highlightUi.heading(highlightUi.section(panel), 0)).toBeVisible();
    await expect(highlightUi.marks(panel)).toHaveCount(0);

    // Archived workspace: highlights still write (201), recolor, delete and undo (F8 → Tab → Enter);
    // the favourite API stays 403 workspace-archived.
    await workspaceFactory.archive(s.owner, s.workspaceId);
    await switchUser(page, s.owner);
    panel = await openPanel(page, s.workspaceId, s.ch1);
    const created = page.waitForResponse(
      (r) => /my-highlights$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST',
    );
    await dragSelect(highlightUi.noteBody(panel), PHRASE_C);
    await chooseColor(page, 'blue');
    expect((await created).status()).toBe(201);
    section = highlightUi.section(panel);
    const row = highlightUi.row(section, PHRASE_C);
    await chooseRowItem(page, row, 'recolor');
    await page
      .getByRole('menuitemradio', { name: /^(분홍|pink)$/i })
      .or(page.getByRole('menuitem', { name: /^(분홍|pink)$/i }))
      .click();
    await expect(row).toContainText(highlightUi.rowMeta('pink', 'note', '버전 1'));
    const before = (await chapterHighlights(s.owner, s.ch1)).find((h) => h.quote === PHRASE_C);
    await chooseRowItem(page, row, 'delete');
    await expect(highlightUi.deletedToast(page)).toBeVisible();
    await expect(highlightUi.row(section, PHRASE_C)).toHaveCount(0);
    await page.keyboard.press('F8');
    await page.keyboard.press('Tab');
    await expect(highlightUi.undo(highlightUi.toastRegion(page))).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(highlightUi.row(section, PHRASE_C)).toHaveCount(1);
    await expectMarkColor(highlightUi.markWith(highlightUi.noteBody(panel), PHRASE_C), 'pink');
    const after = (await chapterHighlights(s.owner, s.ch1)).find((h) => h.quote === PHRASE_C);
    expect(after && before && [after.id, after.color, after.anchor]).toEqual(
      before && [before.id, before.color, before.anchor],
    );
    const favourite = await s.owner.api.request('PATCH', `/questions/${q(s, 1).id}/my-state`, {
      is_favorite: true,
    });
    expect(favourite.status).toBe(403);
    expect((favourite.body as Problem | undefined)?.type).toBe(PROBLEM_TYPES.workspaceArchived);
    expect((await getNote(s.owner, s.ch1)).note).not.toBeNull();
  },
);

test.describe('HILITE-01-AC06 touch', () => {
  const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 14'];
  test.use(iphone);

  test(
    'HILITE-01-AC06 a long-press selection on a touch device opens the menu below the selection and highlights',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const s = await noteSetup(workspaceFactory, 'hilite01-ac06-touch');
      await signInAs(page, s.owner.user);
      const panel = await openPanel(page, s.workspaceId, s.ch1);
      const body = highlightUi.noteBody(panel);
      await touchSelect(body, PHRASE_A);
      const menu = highlightUi.menu(page);
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box, 'the menu is laid out').not.toBeNull();
      const sel = await selectionRect(page);
      expect((box?.y ?? 0) >= sel.bottom - 1, 'below the selection end').toBe(true);
      await highlightUi.colorItem(menu, 'yellow').tap();
      await expect(highlightUi.markWith(body, PHRASE_A)).toHaveCount(1);
      expect((await chapterHighlights(s.owner, s.ch1)).map((h) => h.quote)).toEqual([PHRASE_A]);
    },
  );
});
