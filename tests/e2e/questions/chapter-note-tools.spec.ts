// CHNOTE-02 — 정리 노트 읽기 도구 (항상 펼친 본문 · 노트 안 검색 · 각주 미리보기 · Heatmap 연동),
// docs/screens/chapter-note-tools.md; the panel itself is CHNOTE-01 (chapter-notes.spec.ts).
// Contract half (C01–C03): tests/integration/questions/chapter_notes/
// test_chapter_note_previews_contract.py.
//
// Each test uploads book-ko.pdf into its own workspace, creates CONFIRMED MCQs with explanations in
// "1장 물의 순환" and makes the note with the APP_ENV=test scenario LLM: E2E-NOTE-MIXED (three
// footnotes) for the preview, E2E-NOTE-SEARCH (fixtures/highlights.ts N-SEARCH) for the search.
// Every assumption about UX9-NOTE-B / UX9-NOTE-W / UX9-HL-* (preview API P1, highlight API, UI
// labels) is in the tests/e2e/fixtures/highlights.ts header. Notes and explanations carry answers:
// traces, screenshots and videos are off and no page text is attached on failure.
import type { Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { noteUi, notePanelPath } from '../fixtures/chapter-notes.ts';
import { expectFocusTrapped } from '../fixtures/chapter-redistribution.ts';
import {
  CH1,
  highlightExplanation,
  highlightNote,
  highlightUi,
  keysIn,
  noteSetup,
  noteToolsUi,
  PREVIEW_FORBIDDEN_KEYS,
  questionPreview,
  SEARCH_MARKER,
  type NoteSetup,
} from '../fixtures/highlights.ts';
import {
  createShareLink,
  expect,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  ShareSession,
  test,
} from '../fixtures/sharing.ts';
import {
  JOB_TIMEOUT_MS,
  overviewItem,
  overviewPath,
  panelUi,
  questionNumberName,
  signInAs,
  type Question,
} from '../fixtures/test.ts';
import { homeBackgroundUi } from '../fixtures/ux9-pages.ts';

test.use({
  storageState: { cookies: [], origins: [] },
  ...NO_VISUAL_ARTIFACTS,
  attachPageTextOnFailure: false,
});
test.describe.configure({ timeout: 6 * JOB_TIMEOUT_MS });

/**
 * Total "주의" hits of the search fixture: body 4 + footnote line 1 + the explanation-highlight
 * row's quote 1. Note-body highlight rows of 내 하이라이트 are not searched (user decision
 * 2026-11-02: the body already counts that text).
 */
const ATTENTION_HITS = 6;

function q(s: NoteSetup, n: number): Question {
  const found = s.questions[n - 1];
  if (!found) throw new Error(`no question ${n}`);
  return found;
}

/** The note body group (HighlightableText) of an open panel. */
function body(panel: Locator): Locator {
  return highlightUi.noteBody(panel);
}

/** The body's footnote number links "각주 k". */
function footnoteRef(panel: Locator, k: number): Locator {
  return body(panel)
    .getByRole('link', { name: new RegExp(`^(각주|footnote)\\s*${k}$`, 'i') })
    .first();
}

/** The search fixture: Q1's stem contains "주의" once in its first 40 characters, Q2's none. */
async function searchSetup(
  workspaceFactory: Parameters<typeof noteSetup>[0],
  label: string,
): Promise<NoteSetup> {
  return noteSetup(workspaceFactory, label, {
    count: 2,
    input: (n) =>
      n === 1
        ? { stem: `끓는 물 주의 사항을 고르시오. [${SEARCH_MARKER}]` }
        : {
            stem: `응결이 일어나는 단계를 고르시오. [${SEARCH_MARKER}]`,
            explanation: '응결 해설: 온도 주의 사항을 정리한다.',
          },
  });
}

async function openPanel(page: Page, workspaceId: string, chapterId: string): Promise<Locator> {
  await page.goto(notePanelPath(workspaceId, chapterId));
  const panel = noteUi.panel(page);
  await expect(panel).toBeVisible();
  return panel;
}

/** The note body is shown at once, without any fold/unfold control. */
async function expectAlwaysOpen(panel: Locator): Promise<void> {
  await expect(body(panel)).toBeVisible();
  await expect(noteUi.sectionHeadings(body(panel)).first()).toBeVisible();
  await expect(noteUi.footnoteList(panel)).toBeVisible();
  await expect(noteToolsUi.oldDisclosure(panel)).toHaveCount(0);
  await expect(
    panel.getByRole('button', { name: /펼치|접기|expand|collapse/i, expanded: false }),
  ).toHaveCount(0);
  await expect(noteToolsUi.answersNotice(panel)).toBeVisible();
}

test(
  'CHNOTE-02-AC01 the note body is always open for members and share guests, with the answers notice as text',
  { tag: '@infra' },
  async ({ page, browser, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, 'chnote02-ac01', { scenario: 'mixed', count: 3 });
    await signInAs(page, s.owner.user);
    await page.goto(overviewPath(s.workspaceId));
    const opener = noteUi.opener(noteUi.group(page, CH1), CH1);
    await opener.click();
    let panel = noteUi.panel(page);
    await expectAlwaysOpen(panel);
    await noteUi.close(panel).click();
    await expect(panel).toBeHidden();
    await opener.click();
    panel = noteUi.panel(page);
    await expectAlwaysOpen(panel);

    const link = await createShareLink(s.owner, s.workspaceId);
    const guestContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const guest = await guestContext.newPage();
      await openShareWithSecret(guest, link.id, link.secret);
      await noteUi.sharedChapter(noteUi.sharedCard(guest), CH1).click();
      await expectAlwaysOpen(noteUi.panel(guest));
    } finally {
      await guestContext.close();
    }
  },
);

test(
  'CHNOTE-02-AC02 footnotes preview the stem and options at the pointer or on focus, never answers, and a click still opens the question',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, 'chnote02-ac02', { scenario: 'mixed', count: 3 });
    await signInAs(page, s.owner.user);
    const panel = await openPanel(page, s.workspaceId, s.ch1);
    const ref2 = footnoteRef(panel, 2);
    await expect(ref2).toBeVisible();
    const box = await ref2.boundingBox();
    if (!box) throw new Error('footnote 2 is laid out');
    const point = { x: box.x + box.width * 0.75, y: box.y + box.height * 0.5 };
    await page.mouse.move(point.x, point.y);
    const preview = noteToolsUi.preview(page);
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(noteToolsUi.previewHeading(2));
    await expect(preview).toContainText(`${s.label}-2 문제`);
    for (const x of ['가', '나', '다', '라']) {
      await expect(preview).toContainText(`${s.label}-2 보기 ${x}`);
    }
    await expect(preview).not.toContainText(/정답|해설|correct answer|explanation/i);
    const pbox = await preview.boundingBox();
    expect(pbox, 'the preview is laid out').not.toBeNull();
    if (pbox) {
      // Anchored at the pointer: 8px below/right of it, or flipped/pushed at a viewport edge — the
      // visible width: while a modal is open the page keeps its scrollbar's room (`scrollbar-gutter:
      // stable`, HOMEDLG-01-AC03), which the floating stays clear of.
      const vw = await page.evaluate(() =>
        Math.min(document.documentElement.clientWidth, document.body.clientWidth),
      );
      const near = (a: number, b: number) => Math.abs(a - b) <= 6;
      const xOk =
        near(pbox.x, point.x + 8) ||
        near(pbox.x + pbox.width, point.x - 8) ||
        pbox.x + pbox.width >= vw - 16 - 1;
      const yOk = near(pbox.y, point.y + 8) || near(pbox.y + pbox.height, point.y - 8);
      expect(xOk && yOk, 'the preview is placed at the pointer, not at the element').toBe(true);
      // Moving into the preview keeps it open (scrolling it is allowed).
      await page.mouse.move(pbox.x + 10, pbox.y + 10, { steps: 5 });
      await page.mouse.wheel(0, 40);
      await expect(preview).toBeVisible();
    }
    await page.mouse.move(2, 2);
    await expect(preview).toBeHidden();
    // Hovering is not a view: Q2 is still unseen.
    expect((await overviewItem(s.owner, s.workspaceId, q(s, 2).id)).status).toBe('unseen');

    // Focus-visible: at once, attached to the element, described-by; Escape closes only it.
    const ref1 = footnoteRef(panel, 1);
    await ref1.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(ref1).toBeFocused();
    await expect(preview).toBeVisible();
    const describedBy = (await ref1.getAttribute('aria-describedby')) ?? '';
    expect(describedBy).not.toBe('');
    expect(await preview.getAttribute('id')).toBe(describedBy);
    await page.keyboard.press('Escape');
    await expect(preview).toBeHidden();
    await expect(panel).toBeVisible();

    // A click opens the question's practice panel over the note.
    await ref1.click();
    await expect(panelUi.numbered(page, 1)).toBeVisible();
    await expect(page).toHaveURL((url) => url.searchParams.get('question') === q(s, 1).id);

    // Both preview APIs: stem and options only.
    const member = await questionPreview(s.owner, q(s, 2).id);
    expect(member.status).toBe(200);
    expect(keysIn(member.body).filter((k) => PREVIEW_FORBIDDEN_KEYS.includes(k))).toEqual([]);
    expect(member.body).toMatchObject({ question_id: q(s, 2).id, question_type: 'MCQ' });
    const link = await createShareLink(s.owner, s.workspaceId);
    const session = await ShareSession.open(link.id, link.secret);
    const shared = await session.get(`/questions/${q(s, 2).id}/preview`);
    expect(shared.status).toBe(200);
    expect(keysIn(shared.body).filter((k) => PREVIEW_FORBIDDEN_KEYS.includes(k))).toEqual([]);
    expect((await overviewItem(s.owner, s.workspaceId, q(s, 2).id)).status).toBe('unseen');
  },
);

test.describe('CHNOTE-02-AC02 touch', () => {
  const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 14'];
  test.use(iphone);

  test(
    'CHNOTE-02-AC02 a tap on a footnote shows the preview with 문제 열기 instead of opening the question',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const s = await noteSetup(workspaceFactory, 'chnote02-ac02-touch', {
        scenario: 'mixed',
        count: 3,
      });
      await signInAs(page, s.owner.user);
      const panel = await openPanel(page, s.workspaceId, s.ch1);
      await footnoteRef(panel, 2).tap();
      const preview = noteToolsUi.touchPreview(page);
      await expect(preview).toBeVisible();
      await expect(preview).toContainText(noteToolsUi.previewHeading(2));
      await expect(page).toHaveURL((url) => !url.searchParams.has('question'));
      await noteToolsUi.openQuestion(preview).tap();
      await expect(panelUi.numbered(page, 2)).toBeVisible();
      await expect(page).toHaveURL((url) => url.searchParams.get('question') === q(s, 2).id);
    },
  );
});

test(
  'CHNOTE-02-AC03 노트에서 찾기 finds text in the body, footnotes and 내 하이라이트 across width and case, steps with Enter and the buttons, and Escape clears before closing',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await searchSetup(workspaceFactory, 'chnote02-ac03');
    await highlightNote(s.owner, s.note, 0, 1, '주의 깊게', 'yellow');
    await highlightExplanation(s.owner, q(s, 2), '온도 주의 사항', 'pink');
    await signInAs(page, s.owner.user);
    const panel = await openPanel(page, s.workspaceId, s.ch1);
    const search = noteToolsUi.search(panel);
    await search.fill('주의');
    await expect(noteToolsUi.count(panel, 1, ATTENTION_HITS)).toBeVisible();
    await expect(noteToolsUi.results(panel)).toHaveCount(ATTENTION_HITS);
    await expect(noteToolsUi.current(panel)).toBeInViewport();
    for (const k of [2, 3, 4]) {
      await search.press('Enter');
      await expect(noteToolsUi.count(panel, k, ATTENTION_HITS)).toBeVisible();
    }
    await search.press('Shift+Enter');
    await expect(noteToolsUi.count(panel, 3, ATTENTION_HITS)).toBeVisible();
    await noteToolsUi.next(panel).click();
    await expect(noteToolsUi.count(panel, 4, ATTENTION_HITS)).toBeVisible();
    await expect(
      panel.locator('[aria-live="polite"]').filter({ hasText: /6개 중 4번째|4 of 6/ }),
    ).toHaveCount(1);
    // The current result: a stronger outline and the hidden text "현재 결과" (not color alone).
    await expect(noteToolsUi.current(panel)).toHaveCount(1);
    await expect(noteToolsUi.current(panel)).toContainText(noteToolsUi.currentLabel);
    // A result inside the yellow highlight is marked too (either mark may hold the other).
    expect(
      await body(panel).evaluate((root) =>
        [...root.querySelectorAll('mark[data-highlight-color="yellow"]')].some(
          (m) =>
            m.querySelector('mark[data-search-result]') !== null ||
            m.closest('mark[data-search-result]') !== null,
        ),
      ),
    ).toBe(true);
    // Inside 내 하이라이트 only the explanation-highlight row is searched; the note-body row (same
    // text as the body's yellow mark) is not marked.
    const section = highlightUi.section(panel);
    await expect(section.locator('mark[data-search-result]')).toHaveCount(1);
    await expect(
      highlightUi
        .row(section, highlightUi.rowMeta('pink', 'explanation', '1장 2번'))
        .locator('mark[data-search-result]'),
    ).toHaveCount(1);
    await expect(
      highlightUi
        .row(section, highlightUi.rowMeta('yellow', 'note', '버전 1'))
        .locator('mark[data-search-result]'),
    ).toHaveCount(0);

    await search.fill('attention');
    await expect(noteToolsUi.count(panel, 1, 2)).toBeVisible();
    await search.fill('없는말');
    await expect(noteToolsUi.noResults(panel)).toBeVisible();
    await expect(noteToolsUi.previous(panel)).toBeDisabled();
    await expect(noteToolsUi.next(panel)).toBeDisabled();

    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(noteToolsUi.results(panel)).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(search).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(noteUi.panel(page)).toBeHidden();
  },
);

test(
  'CHNOTE-02-AC04 while the modal note is open the Heatmap is inert and a backdrop click only closes the note; then a marker opens and history never reopens either panel',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, 'chnote02-ac04', { count: 2 });
    await signInAs(page, s.owner.user);
    await page.goto('/workspaces');
    await page.goto(overviewPath(s.workspaceId));
    const homeParams = [...new URL(page.url()).searchParams.entries()];
    const opener = noteUi.opener(noteUi.group(page, CH1), CH1);
    await opener.click();
    const panel = noteUi.panel(page);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    /** The URL lost only the note's panel params (panel=chapter-note, chapter) and has no question. */
    const expectNoteParamsGone = () =>
      expect(page).toHaveURL(
        (url) =>
          !url.searchParams.has('question') &&
          !url.searchParams.has('chapter') &&
          !url.searchParams.getAll('panel').includes('chapter-note') &&
          JSON.stringify([...url.searchParams.entries()]) === JSON.stringify(homeParams),
      );

    // The Heatmap is inert: no focus, no hit-testing; Tab stays in the note. The marker is out of
    // the accessibility tree meanwhile, so it is located hidden-inclusively.
    const marker = homeBackgroundUi
      .heatmap(page)
      .getByRole('button', { name: questionNumberName(1), includeHidden: true });
    expect(await marker.evaluate((el) => el.closest('[inert]') !== null)).toBe(true);
    await expectFocusTrapped(page, panel, 40);
    await expect(marker).not.toBeFocused();
    const box = await marker.boundingBox();
    if (!box) throw new Error('the marker is laid out');
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    expect(
      await marker.evaluate((el, c) => el.contains(document.elementFromPoint(c.x, c.y)), center),
      'a click at the marker does not reach it',
    ).toBe(false);

    // A backdrop click at the marker closes the note (HOMEDLG-01 rule, user decision 2026-11-02)
    // and never activates the marker behind it.
    await page.mouse.click(center.x, center.y);
    await expect(panel).toBeHidden();
    await expect(panelUi.panel(page)).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expectNoteParamsGone();

    // A second click on the marker opens the question; closing it returns focus to the marker.
    await marker.click();
    const play = panelUi.numbered(page, 1);
    await expect(play).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(play).toBeHidden();
    await expect(marker).toBeFocused();

    // Escape closes the note the same way.
    await opener.click();
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(opener).toBeFocused();
    await expectNoteParamsGone();

    await page.goBack();
    await expect(noteUi.panel(page)).toHaveCount(0);
    await expect(panelUi.panel(page)).toHaveCount(0);
    await page.goForward();
    await expect(noteUi.panel(page)).toHaveCount(0);
    await expect(panelUi.panel(page)).toHaveCount(0);
  },
);

test(
  'CHNOTE-02-AC05 a footnote opens the practice panel over the note, hiding the note content until it closes with scroll, search and focus kept',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await searchSetup(workspaceFactory, 'chnote02-ac05');
    await signInAs(page, s.owner.user);
    const panel = await openPanel(page, s.workspaceId, s.ch1);
    const search = noteToolsUi.search(panel);
    await search.fill('주의');
    await expect(noteToolsUi.count(panel, 1, 5)).toBeVisible();
    await search.press('Enter');
    await search.press('Enter');
    await expect(noteToolsUi.count(panel, 3, 5)).toBeVisible();
    // Scroll the panel's scroll container a little.
    const scroller = panel
      .locator('*')
      .filter({
        has: page.getByRole('group', { name: /^(정리 노트 본문|chapter note body|note body)$/i }),
      })
      .last();
    const readScroll = () =>
      scroller.evaluate((el) => {
        let node: HTMLElement | null = el as HTMLElement;
        while (node && node.scrollHeight <= node.clientHeight) node = node.parentElement;
        return node?.scrollTop ?? 0;
      });
    /** The scroll position once a (smooth) scroll has come to rest. */
    const restingScroll = async () => {
      let last = -1;
      await expect
        .poll(async () => {
          const now = await readScroll();
          const rested = now === last;
          last = now;
          return rested;
        })
        .toBe(true);
      return last;
    };
    await restingScroll();
    await body(panel).hover();
    await page.mouse.wheel(0, 60);
    await expect.poll(readScroll).toBeGreaterThan(0);
    const scrollTop = await restingScroll();

    const ref = footnoteRef(panel, 1);
    await ref.click();
    const play = panelUi.numbered(page, 1);
    await expect(play).toBeVisible();
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.getAll('panel').includes('chapter-note') &&
        url.searchParams.get('question') === q(s, 1).id,
    );
    // Hidden-inclusive locators: the masked content (visibility: hidden + inert) must still
    // resolve, so the checks below cannot pass vacuously.
    const note = page.getByRole('dialog', {
      name: /^(정리 노트|chapter notes?)$/i,
      includeHidden: true,
    });
    await expect(note).toHaveCount(1);
    const masked = [
      note.getByRole('group', {
        name: /^(정리 노트 본문|chapter note body|note body)$/i,
        includeHidden: true,
      }),
      note.getByRole('list', { name: /^(각주|footnotes)$/i, includeHidden: true }),
      note.getByRole('region', { name: /^(내 하이라이트|my highlights)/i, includeHidden: true }),
    ];
    for (const part of masked) {
      await expect(part).toHaveCount(1);
      await expect(part).toBeHidden();
      expect(
        await part.evaluate((el) => {
          const hidden = getComputedStyle(el).visibility === 'hidden';
          return hidden && el.closest('[inert]') !== null;
        }),
      ).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(play).toBeHidden();
    await expect(body(panel)).toBeVisible();
    await expect(search).toHaveValue('주의');
    await expect(noteToolsUi.count(panel, 3, 5)).toBeVisible();
    await expect(ref).toBeFocused();
    expect(await restingScroll()).toBe(scrollTop);
  },
);
