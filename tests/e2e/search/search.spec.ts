// SEARCH-01 — 문제 검색·본문 검색 (docs/screens/search.md; UX7-SEARCH split the unified box): the 문제
// search filters the home's heatmap live (`/workspaces/:workspaceId?q=`); the 본문 search runs on
// Enter on its own page since UX9 (`/workspaces/:workspaceId/search?text=`, SEARCH-02 — the home's
// collapsed area and SEARCH-01-AC10 are retired; the home's `text=` and the old `/search?q=`
// redirect there);
// search flow docs/architecture.md §4 (keyword | semantic | hybrid, server-side workspace and
// published-revision filters, SourceLocation = page + block + revision).
//
// Each test indexes synthetic books (tests/fixtures/pdfs) into its own workspace through the
// public upload flow. E2E runs the deterministic fake embedder/reranker (docs/e2e-strategy.md §3):
// these tests check the UI/API contract and source mapping, not retrieval quality (eval/ does).
// Queries come from tests/fixtures/pdfs/retrieval-seed.json (q-ko-01 → section ch2-s2, page 4).
import { devices, type Locator } from '@playwright/test';
import {
  block,
  book,
  chooseFilter,
  closeSearchOptions,
  createQuestion,
  editorUi,
  expect,
  homePath,
  homeUi,
  JOB_TIMEOUT_MS,
  listDocuments,
  main,
  mcqInput,
  notFoundHeading,
  openContentSearch,
  openSearchOptions,
  outlineNodeId,
  overviewUi,
  pageLabel,
  runSearch,
  search,
  searchPath,
  searchUi,
  section,
  signInAs,
  test,
  uploadPdf,
  uploadReadyBook,
  waitForJob,
  type Problem,
  type SearchItem,
} from '../fixtures/test.ts';
import { homeBackgroundUi, isBlocked } from '../fixtures/ux9-pages.ts';
import {
  createShareLink,
  expectFragmentRemoved,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  sharedUi,
  test as sharingTest,
} from '../fixtures/sharing.ts';

test.use({ storageState: { cookies: [], origins: [] } });
// The AC06 shared-view case opens a share link. Like every sharing spec it runs without trace,
// screenshot and video (a trace records the secret exchange; the sharing fixture redacts page text
// and errors, not traces), and Playwright allows these options per file only, not per describe.
test.use(NO_VISUAL_ARTIFACTS);
test.describe.configure({ timeout: 2 * JOB_TIMEOUT_MS + 60_000 });

const EN = book('book-en');
const KO = book('book-ko');
const KO_QUERY = '정수장에서 염소를 넣는 이유'; // retrieval-seed q-ko-01
const CHLORINE_EN = block(EN, 'ch2-s2-p2');
const CHLORINE_PAGE = CHLORINE_EN.parts[0]?.page ?? 0;
const HANGUL = /[가-힣]/;
const RANDOM_ID = '00000000-0000-4000-8000-000000000000';
// APP_ENV=test only: a query containing this marker makes the API's query embedder fail like an
// unavailable hosted embedder (quiz_api.search_engine, M7.4b), deterministically.
const EMBEDDING_FAILURE_MARKER = 'E2E-FAIL-EMBEDDING';
// No document contains it: with the marker, the keyword fallback finds nothing.
const NONSENSE = 'zqxjv-없는-검색어-0000';
const DEGRADED_NOTICE =
  /의미 검색을 일시적으로 사용할 수 없어 키워드 결과만|semantic search is temporarily unavailable/i;

interface SearchEnvelope {
  readonly degraded: readonly string[];
  readonly items: readonly (SearchItem & { readonly score_type: string })[];
}

test(
  'SEARCH-01-AC01 a Korean question over an English book shows the related English text and its PDF page',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac01');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-en');

    await signInAs(page, owner.user);
    await page.goto(searchPath(ws.id));
    await runSearch(page, KO_QUERY, 'semantic');

    const items = searchUi.resultItems(page);
    await expect(items.first()).toBeVisible();
    const relevant = items.filter({ hasText: /chlorine|disinfect/i }).first();
    await expect(relevant).toBeVisible();
    await expect(relevant).toContainText(pageLabel(CHLORINE_PAGE));
    await expect(relevant).toContainText(/water cycle and water treatment|book-en/i);

    // Server contract: English source text with its location, from this document only.
    const hits = await search(owner, ws.id, { query: KO_QUERY, mode: 'semantic' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.document_id === documentId && !HANGUL.test(h.text))).toBe(true);
    expect(hits.some((h) => /chlorine/i.test(h.text) && h.page === CHLORINE_PAGE)).toBe(true);
  },
);

test(
  'SEARCH-01-AC02 document and chapter filters make the server search only that scope in every mode',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac02');
    const ws = await workspaceFactory.create(owner);
    const enId = await uploadReadyBook(owner, ws.id, 'book-en');
    const koId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const chapter2 = section(EN, 'ch2');

    // Control for the filters below: unfiltered, both books are searchable.
    const seen = new Set<string>();
    for (const query of ['water', '정수 처리']) {
      for (const h of await search(owner, ws.id, { query, mode: 'keyword' }))
        seen.add(h.document_id);
    }
    expect(seen).toEqual(new Set([enId, koId]));

    // Chapter ids come from the server's outline (never from the truth file's ids).
    const chapterId = await outlineNodeId(owner, enId, chapter2.title);
    const outsideChapter = (h: SearchItem) => h.page !== chapter2.page;
    for (const mode of ['keyword', 'semantic', 'hybrid'] as const) {
      const byDocument = await search(owner, ws.id, { query: 'water', mode, document_ids: [enId] });
      expect(byDocument.length, mode).toBeGreaterThan(0);
      expect(
        byDocument.every((h) => h.document_id === enId),
        mode,
      ).toBe(true);
      // Control: without the chapter filter the same query also hits chapter 1 (pages 2-3).
      expect(byDocument.some(outsideChapter), `${mode} control`).toBe(true);

      const byChapter = await search(owner, ws.id, {
        query: 'water',
        mode,
        document_ids: [enId],
        chapter_ids: [chapterId],
      });
      expect(byChapter.length, mode).toBeGreaterThan(0);
      expect(
        byChapter.every((h) => h.document_id === enId && !outsideChapter(h)),
        mode,
      ).toBe(true);
      // Chapter filter alone is enforced by the server too (both books have a "chapter 2").
      const chapterOnly = await search(owner, ws.id, {
        query: 'water',
        mode,
        chapter_ids: [chapterId],
      });
      expect(chapterOnly.length, mode).toBeGreaterThan(0);
      expect(
        chapterOnly.every((h) => h.document_id === enId && !outsideChapter(h)),
        mode,
      ).toBe(true);
    }

    await signInAs(page, owner.user);
    await page.goto(searchPath(ws.id));
    await openSearchOptions(page);
    await chooseFilter(
      page,
      searchUi.documentFilter(page),
      /water cycle and water treatment|book-en/i,
    );
    await chooseFilter(page, searchUi.chapterFilter(page), new RegExp(chapter2.title, 'i'));
    for (const mode of ['keyword', 'semantic', 'hybrid'] as const) {
      await runSearch(page, 'water', mode);
      const items = searchUi.resultItems(page);
      await expect(items.first(), mode).toBeVisible();
      // Page label on the whole item; language only on the excerpt (UI metadata is Korean).
      for (const text of await items.allInnerTexts()) {
        expect(text, mode).toMatch(pageLabel(chapter2.page));
      }
      for (const excerpt of await searchUi.excerpt(items).allInnerTexts()) {
        expect(excerpt, mode).not.toMatch(HANGUL);
      }
      expect(await searchUi.excerpt(items).count(), mode).toBe(await items.count());
    }
  },
);

test(
  'SEARCH-01-AC03 choosing an excerpt opens its source text and jumps to the PDF page',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac03');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-en');

    await signInAs(page, owner.user);
    await page.goto(searchPath(ws.id));
    await runSearch(page, 'chlorine', 'keyword');
    const hit = searchUi
      .resultItems(page)
      .filter({ hasText: /chlorine/i })
      .first();
    await hit.getByRole('button').first().click();

    // FloatingSidePanel over the results (modal since UX9, HOMEDLG-01: the search form and the
    // results behind it are inert): paragraph-complete excerpt + page.
    const panel = searchUi.excerptPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    await expect(panel).toContainText(CHLORINE_EN.text);
    await expect(panel).toContainText(pageLabel(CHLORINE_PAGE));
    const box = page.locator('main').getByRole('searchbox', {
      name: /^(본문 검색어|body search (query|text))$/i,
      includeHidden: true,
    });
    expect(await isBlocked(box), 'the search box is inert').toBe(true);

    await searchUi.openInPdf(panel).click();
    await expect(page).toHaveURL(
      (url) => url.pathname === `/workspaces/${ws.id}/documents/${documentId}`,
    );
    await expect(editorUi.currentPage(page)).toHaveValue(String(CHLORINE_PAGE));
    await expect(editorUi.highlight(page)).toBeVisible();
    await page.getByRole('checkbox', { name: '변환본', exact: true }).check();
    await expect(editorUi.currentBlock(page)).toContainText(CHLORINE_EN.text.slice(0, 40));
  },
);

test(
  'SEARCH-01-AC04 a search without results shows a clear empty state with guidance',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac04');
    const ws = await workspaceFactory.create(owner);
    await uploadReadyBook(owner, ws.id, 'book-ko');
    const nonsense = 'zqxjv-없는-검색어-0000';
    expect(await search(owner, ws.id, { query: nonsense, mode: 'keyword' })).toEqual([]);

    await signInAs(page, owner.user);
    await page.goto(searchPath(ws.id));
    await runSearch(page, nonsense, 'keyword');
    await expect(searchUi.emptyState(page)).toBeVisible();
    await expect(page.getByRole('main')).toContainText(
      /다른 검색어|검색어를 (바꾸|수정|확인)|필터를|try (a )?different|adjust|change your/i,
    );
    await expect(searchUi.resultItems(page)).toHaveCount(0);

    // Control: the same screen does find indexed text.
    await runSearch(page, block(KO, 'ch2-s2-p2').text.slice(0, 8), 'keyword');
    await expect(searchUi.resultItems(page).first()).toBeVisible();
  },
);

test(
  "SEARCH-01-AC05 calling another user's workspace search API directly never exposes document text",
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac05-owner');
    const stranger = await workspaceFactory.member('search01-ac05-stranger');
    const ws = await workspaceFactory.create(owner);
    await uploadReadyBook(owner, ws.id, 'book-en');
    const own = await search(owner, ws.id, { query: 'chlorine', mode: 'keyword' });
    expect(
      own.some((h) => /chlorine/i.test(h.text)),
      'owner control',
    ).toBe(true);

    const never = await stranger.api.request('POST', `/workspaces/${RANDOM_ID}/search`, {
      query: 'chlorine',
      mode: 'keyword',
    });
    expect(never.status).toBe(404);
    for (const mode of ['keyword', 'semantic', 'hybrid'] as const) {
      const res = await stranger.api.request('POST', `/workspaces/${ws.id}/search`, {
        query: 'chlorine',
        mode,
      });
      expect(res.status, mode).toBe(404);
      expect((res.body as Problem).detail, mode).toBe((never.body as Problem).detail);
      expect(res.text, mode).not.toMatch(/chlorine|disinfect|water/i);
    }

    await signInAs(page, stranger.user);
    const res = await page.goto(`/workspaces/${ws.id}/search`);
    expect(res?.status()).toBe(404);
    await expect(notFoundHeading(page)).toBeVisible();
  },
);

test(
  'SEARCH-01-AC06 when query embedding is unavailable, search falls back to keyword results with a non-blocking notice',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac06');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-en');
    const run = (query: string, mode: 'semantic' | 'hybrid') =>
      owner.api.ok<SearchEnvelope>('POST', `/workspaces/${ws.id}/search`, { query, mode }, [200]);

    // Control: the dense side works, so hybrid fuses both lists and nothing is degraded.
    const healthy = await run('chlorine', 'hybrid');
    expect(healthy.degraded).toEqual([]);
    expect(healthy.items.length).toBeGreaterThan(0);
    expect(healthy.items.every((h) => h.score_type === 'rrf')).toBe(true);

    // Dense unavailable: 200 with BM25 hits only, flagged as degraded, in both dense modes.
    const failing = `chlorine ${EMBEDDING_FAILURE_MARKER}`;
    for (const mode of ['hybrid', 'semantic'] as const) {
      const degraded = await run(failing, mode);
      expect(degraded.degraded, mode).toEqual(['dense_unavailable']);
      expect(degraded.items.length, mode).toBeGreaterThan(0);
      expect(
        degraded.items.every((h) => h.score_type === 'bm25' && h.document_id === documentId),
        mode,
      ).toBe(true);
      expect(
        degraded.items.some((h) => /chlorine/i.test(h.text)),
        mode,
      ).toBe(true);
    }

    await signInAs(page, owner.user);
    await page.goto(searchPath(ws.id));
    await runSearch(page, failing, 'hybrid');
    const items = searchUi.resultItems(page);
    await expect(items.first()).toBeVisible();
    const notice = page.getByRole('main').getByRole('status').filter({ hasText: DEGRADED_NOTICE });
    await expect(notice).toBeVisible();
    // Non-blocking: the results stay usable next to the notice.
    await items
      .filter({ hasText: /chlorine/i })
      .first()
      .getByRole('button')
      .first()
      .click();
    await expect(searchUi.excerptPanel(page)).toBeVisible();
    // UX9: the excerpt panel is modal (the search form behind it is inert); closed again.
    await page.keyboard.press('Escape');
    await expect(searchUi.excerptPanel(page)).toHaveCount(0);

    // The notice belongs to the degraded answer only.
    await runSearch(page, 'chlorine', 'hybrid');
    await expect(items.first()).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText(DEGRADED_NOTICE);

    // Degraded and the keyword fallback finds nothing: the empty state AND the notice.
    const emptyFailing = `${NONSENSE} ${EMBEDDING_FAILURE_MARKER}`;
    const empty = await run(emptyFailing, 'hybrid');
    expect(empty.degraded).toEqual(['dense_unavailable']);
    expect(empty.items).toEqual([]);
    // Fresh page: a mode switch re-runs the last search and Enter waits for it.
    await page.goto(searchPath(ws.id));
    await runSearch(page, emptyFailing, 'hybrid');
    await expect(searchUi.emptyState(page)).toBeVisible();
    await expect(notice).toBeVisible();
  },
);

const NO_QUESTIONS = /검색할 문제가 없|no questions to search/i;
const NO_BODY = /검색할 본문이 없|no (body|documents) to search/i;
const SCOPE_CHECKBOX = /^(문제|본문|questions|body|content)$/i;

test(
  'SEARCH-01-AC09 the 문제 search on the home and the 본문 search on its page are separate inputs with their own settings, URL keys and results',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac09');
    const ws = await workspaceFactory.create(owner);
    await uploadReadyBook(owner, ws.id, 'book-en');
    await createQuestion(
      owner,
      ws.id,
      mcqInput('search01-ac09 chlorine 소독 문제', ['예', '아니오']),
    );
    await createQuestion(owner, ws.id, mcqInput('search01-ac09 다른 문제', ['예', '아니오']));

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(2);
    // No unified box, no scope checkboxes, no "검색 옵션" popover (UX7-SEARCH); no 본문 box on
    // the home either (UX9: its header links to the search page instead).
    await expect(main(page).getByRole('checkbox', { name: SCOPE_CHECKBOX })).toHaveCount(0);
    await expect(
      main(page).getByRole('button', { name: /^(검색 옵션|search options)$/i }),
    ).toHaveCount(0);
    await expect(searchUi.box(page)).toHaveCount(0);
    await homeUi.openMenu(page);
    await expect(homeUi.contentSearchLink(page)).toBeVisible();
    await page.keyboard.press('Escape');
    const questionBox = homeUi.questionSearch(page);
    await expect(questionBox).toBeVisible();
    await expect(questionBox).toBeEnabled();

    // 문제 설정 (next to the 문제 search) by click: chapter and type only.
    const questionSettings = homeUi.searchSettingsButton(page, 'questions');
    await expect(questionSettings).toHaveAttribute('aria-expanded', 'true');
    const questionPopover = homeUi.searchSettings(page, 'questions');
    await expect(questionPopover).toBeVisible();
    await expect(questionSettings).toHaveAttribute('aria-expanded', 'true');
    await expect(
      questionPopover.getByRole('combobox', { name: /^(챕터|chapter)$/i }),
    ).toBeVisible();
    await expect(questionPopover.getByRole('combobox', { name: /^(유형|type)$/i })).toBeVisible();
    await expect(questionPopover.getByRole('radiogroup')).toHaveCount(0);
    await closeSearchOptions(page, 'questions');
    await expect(questionSettings).toBeFocused();

    // The 문제 search filters the heatmap only (URL `q`).
    await questionBox.fill('chlorine');
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'chlorine');
    await expect(searchUi.resultsRegion(page)).toHaveCount(0);

    // The search page: 본문 설정 (inside the 본문 search) by keyboard: mode, document and section
    // filters only. No 문제 search there.
    await openContentSearch(page);
    await expect(page).toHaveURL((url) => url.pathname === searchPath(ws.id));
    await expect(homeUi.questionSearch(page)).toHaveCount(0);
    await expect(searchUi.box(page)).toHaveValue('');
    const bodySettings = homeUi.searchSettingsButton(page, 'body');
    await expect(homeUi.contentSearch(page).getByRole('button', { name: /설정/ })).toHaveCount(1);
    await bodySettings.focus();
    await page.keyboard.press('Enter');
    const bodyPopover = homeUi.searchSettings(page, 'body');
    await expect(bodyPopover).toBeVisible();
    await expect(bodySettings).toHaveAttribute('aria-expanded', 'true');
    await expect(
      bodyPopover.getByRole('radiogroup', { name: /검색 방식|search mode/i }),
    ).toBeVisible();
    await expect(bodyPopover.getByRole('combobox', { name: /^(문서|document)$/i })).toBeVisible();
    await expect(bodyPopover.getByRole('combobox', { name: /^(챕터|chapter)$/i })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /문제지|question papers?/i })).toHaveCount(0);
    await closeSearchOptions(page, 'body');
    await expect(bodySettings).toBeFocused();
    await expect(searchUi.submit(page)).toHaveText('');

    // The 본문 search finds body text (URL `text`); the 문제 search's `q` is not carried along.
    await searchUi.box(page).fill('chlorine');
    await searchUi.submit(page).click();
    await expect(
      searchUi
        .resultItems(page)
        .filter({ hasText: /chlorine/i })
        .first(),
    ).toBeVisible();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get('text') === 'chlorine' && !url.searchParams.has('q'),
    );

    // A reload shows the same search.
    await page.reload();
    await expect(searchUi.box(page)).toHaveValue('chlorine');
    await expect(searchUi.resultItems(page).first()).toBeVisible();

    // Back on the home, the 문제 search and its heatmap are as they were.
    await page.goBack();
    await expect(page).toHaveURL(
      (url) => url.pathname === homePath(ws.id) && url.searchParams.get('q') === 'chlorine',
    );
    await expect(homeUi.questionSearch(page)).toHaveValue('chlorine');
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await page.goForward();
    await expect(searchUi.box(page)).toHaveValue('chlorine');
    await expect(searchUi.resultItems(page).first()).toBeVisible();

    // "검색 결과 지우기" clears the 본문 search: its query, results and `text`.
    await searchUi.closeResults(page).click();
    await expect(searchUi.resultsRegion(page)).toHaveCount(0);
    await expect(page).toHaveURL(
      (url) => url.pathname === searchPath(ws.id) && !url.searchParams.has('text'),
    );
    await expect(searchUi.box(page)).toHaveValue('');
  },
);

test(
  'SEARCH-01-AC09 each search is disabled with a stated reason when it has nothing to search',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac09-disabled');
    const ws = await workspaceFactory.create(owner);

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    // No question: the 문제 search is disabled and says why.
    const questionBox = homeUi.questionSearch(page);
    await expect(questionBox).toBeDisabled();
    await expect(homeUi.questionSearchMessage(page)).toHaveText(NO_QUESTIONS);
    await expect(questionBox).toHaveAccessibleDescription(NO_QUESTIONS);
    // No published document: the 본문 search box and button are disabled.
    await openContentSearch(page);
    const submit = searchUi.submit(page);
    await expect(submit).toBeDisabled();
    await expect(homeUi.contentSearchMessage(page)).toHaveText(NO_BODY);
    await expect(submit).toHaveAccessibleDescription(NO_BODY);
    await expect(searchUi.box(page)).toBeDisabled();
    await expect(searchUi.box(page)).toHaveAccessibleDescription(NO_BODY);
    await expect(searchUi.resultsRegion(page)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has('text')).toBe(false);

    // Questions now: the 문제 search works, the 본문 search is still disabled.
    await createQuestion(owner, ws.id, mcqInput('search01-ac09 chlorine 문제', ['예', '아니오']));
    await createQuestion(owner, ws.id, mcqInput('search01-ac09 다른 문제', ['예', '아니오']));
    await page.goto(homePath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(2);
    await expect(homeUi.questionSearch(page)).toBeEnabled();
    await expect(homeUi.questionSearchMessage(page)).toHaveText('');
    await homeUi.questionSearch(page).fill('chlorine');
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await openContentSearch(page);
    await expect(searchUi.submit(page)).toBeDisabled();
  },
);

test(
  'SEARCH-01-AC09 browser Back restores the earlier body search, and old home and route URLs move to the search page',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac09-back');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-en');

    await signInAs(page, owner.user);
    await page.goto(searchPath(ws.id));
    await runSearch(page, 'chlorine', 'keyword');
    const items = searchUi.resultItems(page);
    await expect(items.filter({ hasText: /chlorine/i }).first()).toBeVisible();
    // A second search rewrites the entry's query (no new entry).
    const entries = await page.evaluate(() => window.history.length);
    await searchUi.box(page).fill('evaporation');
    await searchUi.box(page).press('Enter');
    await expect(page).toHaveURL((url) => url.searchParams.get('text') === 'evaporation');
    await expect(items.filter({ hasText: /evaporat/i }).first()).toBeVisible();
    expect(await page.evaluate(() => window.history.length)).toBe(entries);

    // Back from the PDF viewer and Back onto the page restore the search it had.
    await items.first().getByRole('button').first().click();
    await searchUi.openInPdf(searchUi.excerptPanel(page)).click();
    await expect(page).toHaveURL(
      (url) => url.pathname === `/workspaces/${ws.id}/documents/${documentId}`,
    );
    await page.goBack();
    await expect(page).toHaveURL((url) => url.searchParams.get('text') === 'evaporation');
    await expect(searchUi.box(page)).toHaveValue('evaporation');
    await expect(items.filter({ hasText: /evaporat/i }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.goto('/workspaces');
    await page.goBack();
    await expect(page).toHaveURL((url) => url.searchParams.get('text') === 'evaporation');
    await expect(searchUi.box(page)).toHaveValue('evaporation');
    await expect(items.filter({ hasNotText: /evaporat/i })).toHaveCount(0);
    await expect(items.first()).toBeVisible();

    // The unified search's body-only URL (UX6), the home's 본문 search and the pre-UX3c route
    // open the search page.
    await page.goto(homePath(ws.id, 'q=chlorine&scope=content&mode=keyword'));
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === searchPath(ws.id) &&
        url.searchParams.get('text') === 'chlorine' &&
        url.searchParams.get('mode') === 'keyword' &&
        !url.searchParams.has('q') &&
        !url.searchParams.has('scope'),
    );
    await expect(searchUi.box(page)).toHaveValue('chlorine');
    await expect(items.filter({ hasText: /chlorine/i }).first()).toBeVisible();
    await page.goto(homePath(ws.id, 'text=evaporation&q=chlorine'));
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === searchPath(ws.id) &&
        url.searchParams.get('text') === 'evaporation' &&
        !url.searchParams.has('q'),
    );
    await expect(items.filter({ hasText: /evaporat/i }).first()).toBeVisible();
    await page.goto(`/workspaces/${ws.id}/search?q=chlorine&mode=keyword`);
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === searchPath(ws.id) &&
        url.searchParams.get('text') === 'chlorine' &&
        !url.searchParams.has('q'),
    );
    await expect(items.filter({ hasText: /chlorine/i }).first()).toBeVisible();
  },
);

/** Whether the keyword in `panel` is marked by more than colour (bold or underlined). */
async function expectMarkedKeyword(panel: Locator, keyword: RegExp): Promise<void> {
  const mark = panel.locator('mark').filter({ hasText: keyword }).first();
  await expect(mark).toBeVisible();
  const style = await mark.evaluate((el) => {
    const s = getComputedStyle(el);
    return { weight: Number(s.fontWeight), decoration: s.textDecorationLine };
  });
  expect(style.weight >= 600 || style.decoration.includes('underline')).toBe(true);
}

test(
  'SEARCH-01-AC11 clicking anywhere on a body result opens its text around the keyword in a modal panel; 이전/다음 결과 and the keyboard do the same',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac11');
    const ws = await workspaceFactory.create(owner);
    await uploadReadyBook(owner, ws.id, 'book-en');

    await signInAs(page, owner.user);
    await page.goto(searchPath(ws.id));
    await runSearch(page, 'water', 'keyword');
    const items = searchUi.resultItems(page);
    await expect(items.nth(1)).toBeVisible();
    const panel = searchUi.excerptPanel(page);
    await expect(panel).toHaveCount(0);
    const listBefore = await searchUi.results(page).boundingBox();
    const first = items.first();
    const second = items.nth(1);
    // Behind the modal panel the results are hidden from assistive technology: found with them.
    const hits = homeBackgroundUi
      .searchResults(page)
      .getByRole('listitem', { includeHidden: true });
    const firstTitle = hits.first().getByRole('button', { includeHidden: true }).first();
    const secondTitle = hits.nth(1).getByRole('button', { includeHidden: true }).first();
    const textOf = async (item: Locator) =>
      (await searchUi.excerpt(item).innerText()).replace(/…/g, '').trim();
    const firstText = await textOf(first);
    const secondText = await textOf(second);

    // Mouse on the excerpt paragraph (not the title) of the second hit. UX9 (user decision
    // 2026-11-02): the panel is modal — the results behind it are inert and do not step aside.
    await searchUi.excerpt(second).click();
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(await isBlocked(homeBackgroundUi.searchResults(page)), 'results are inert').toBe(true);
    expect(await homeBackgroundUi.searchResults(page).boundingBox()).toEqual(listBefore);
    await expect(panel).toContainText(secondText.slice(0, 30));
    await expectMarkedKeyword(panel, /water/i);
    await expect(secondTitle).toHaveAttribute('aria-current', 'true');

    // 이전 결과 moves the panel to the result before it (the list's order).
    await panel.getByRole('button', { name: /^(이전 결과|previous result)$/i }).click();
    await expect(panel).toContainText(firstText.slice(0, 30));
    await expect(firstTitle).toHaveAttribute('aria-current', 'true');
    await expect(secondTitle).not.toHaveAttribute('aria-current', 'true');
    await expect(
      panel.getByRole('button', { name: /^(이전 결과|previous result)$/i }),
    ).toBeDisabled();
    // Alt+↓ is 다음 결과.
    await page.keyboard.press('Alt+ArrowDown');
    await expect(panel).toContainText(secondText.slice(0, 30));
    await expect(secondTitle).toHaveAttribute('aria-current', 'true');

    // Escape closes it; focus goes to the result last shown.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(secondTitle).toBeFocused();

    // Keyboard: the first hit's title button with Enter opens it.
    await firstTitle.focus();
    await page.keyboard.press('Enter');
    await expect(panel).toContainText(firstText.slice(0, 30));
    await expect(firstTitle).toHaveAttribute('aria-current', 'true');
  },
);

test.describe('SEARCH-01-AC11 touch', () => {
  const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 14'];
  test.use(iphone);

  test(
    'SEARCH-01-AC11 tapping a body result on a phone opens its text around the keyword in the bottom sheet',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const owner = await workspaceFactory.member('search01-ac11-touch');
      const ws = await workspaceFactory.create(owner);
      await uploadReadyBook(owner, ws.id, 'book-en');

      await signInAs(page, owner.user);
      await page.goto(searchPath(ws.id));
      await expect(searchUi.box(page)).toBeVisible();
      await searchUi.box(page).fill('chlorine');
      await searchUi.box(page).press('Enter');
      const hit = searchUi
        .resultItems(page)
        .filter({ hasText: /chlorine/i })
        .first();
      await expect(hit).toBeVisible();
      await searchUi.excerpt(hit).tap();
      const panel = searchUi.excerptPanel(page);
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(CHLORINE_EN.text.slice(0, 40));
      await expectMarkedKeyword(panel, /chlorine/i);
      // The existing mobile sheet: anchored to the bottom of the viewport.
      const viewport = page.viewportSize();
      await expect
        .poll(async () => {
          const box = await panel.boundingBox();
          return box && viewport ? Math.round(viewport.height - (box.y + box.height)) : null;
        })
        .toBe(0);
    },
  );
});

const QUESTION_TITLES = [
  'search01-ac12 chlorine 소독',
  'search01-ac12 염소 처리',
  'search01-ac12 다른 문제',
] as const;

test(
  'SEARCH-01-AC12 the 문제 search filters the heatmap live without Enter, keeps the typed text and replaces history',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac12');
    const ws = await workspaceFactory.create(owner);
    for (const title of QUESTION_TITLES) {
      await createQuestion(owner, ws.id, mcqInput(title, ['예', '아니오']));
    }

    const overviewApi = `/api/workspaces/${ws.id}/questions/overview`;
    const overviewRequests: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname === overviewApi) overviewRequests.push(url.search);
    });

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(3);
    expect(overviewRequests).toHaveLength(0);
    const box = homeUi.questionSearch(page);
    const historyLength = await page.evaluate(() => window.history.length);

    // Typed key by key, never Enter: debounced so intermediate keystrokes do not each fire a request.
    await box.pressSequentially('search01-ac12', { delay: 20 });
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'search01-ac12');
    await expect(overviewUi.dots(page)).toHaveCount(3);
    expect(overviewRequests).toEqual(['?q=search01-ac12']);
    await box.pressSequentially(' chlorine', { delay: 20 });
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'search01-ac12 chlorine');
    await expect(box).toHaveValue('search01-ac12 chlorine');
    expect(overviewRequests).toEqual(['?q=search01-ac12', '?q=search01-ac12+chlorine']);

    // Editing in the middle: the caret stays where the user typed while the heatmap re-reads.
    const caret = 'search01-ac12 '.length;
    await box.evaluate((el: HTMLInputElement, at: number) => el.setSelectionRange(at, at), caret);
    await box.pressSequentially('x', { delay: 0 });
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'search01-ac12 xchlorine');
    await expect(overviewUi.heatmap(page)).toHaveCount(0); // filtered empty state
    await expect(box).toHaveValue('search01-ac12 xchlorine');
    expect(await box.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(
      'search01-ac12 x'.length,
    );
    const afterMiss = overviewRequests.length;
    // Backspace returns to the cached query `search01-ac12 chlorine`: zero new BFF requests.
    await box.press('Backspace');
    await expect(overviewUi.dots(page)).toHaveCount(1);
    expect(overviewRequests).toHaveLength(afterMiss);

    // Clearing (`fill('')`) restores every question immediately with zero new BFF requests.
    await box.fill('');
    await expect(overviewUi.dots(page)).toHaveCount(3);
    await expect(page).toHaveURL((url) => !url.searchParams.has('q'));
    expect(overviewRequests).toHaveLength(afterMiss);

    // Re-applying a cached query and clearing via Backspace also hit cache with zero network calls.
    await box.fill('search01-ac12 chlorine');
    await expect(overviewUi.dots(page)).toHaveCount(1);
    expect(overviewRequests).toHaveLength(afterMiss);
    await box.selectText();
    await box.press('Backspace');
    await expect(overviewUi.dots(page)).toHaveCount(3);
    await expect(page).toHaveURL((url) => !url.searchParams.has('q'));
    expect(overviewRequests).toHaveLength(afterMiss);

    // Fast typing / superseding: an earlier in-flight BFF request (`?q=염`) is aborted/superseded
    // when a newer query (`?q=염소`) commits, so a late answer never wins.
    let held = 0;
    let aborted = 0;
    await page.route(
      (url) => url.pathname === overviewApi && url.searchParams.get('q') === '염',
      async (route) => {
        held += 1;
        route.request().failure();
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.continue().catch(() => {
          aborted += 1;
        });
      },
    );
    page.on('requestfailed', (req) => {
      const url = new URL(req.url());
      if (url.pathname === overviewApi && url.searchParams.get('q') === '염') aborted += 1;
    });
    await box.fill('염');
    await expect.poll(() => held).toBeGreaterThan(0);
    await box.pressSequentially('소', { delay: 0 });
    await expect(box).toHaveValue('염소');
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === '염소');
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect.poll(() => aborted).toBeGreaterThan(0);
    await page.waitForTimeout(1_600);
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(box).toHaveValue('염소');
    await page.unrouteAll({ behavior: 'ignoreErrors' });

    // Clearing shows every question from cache; typing never added history entries.
    const beforeFinalClear = overviewRequests.length;
    await box.fill('');
    await expect(overviewUi.dots(page)).toHaveCount(3);
    await expect(page).toHaveURL((url) => !url.searchParams.has('q'));
    expect(overviewRequests).toHaveLength(beforeFinalClear);
    expect(await page.evaluate(() => window.history.length)).toBe(historyLength);

    // Direct landing on `?q=염소`: SSR seeds unfilteredOverview, so clearing hits cache (0 fetches).
    await page.goto(`${homePath(ws.id)}?q=${encodeURIComponent('염소')}`);
    await expect(overviewUi.dots(page)).toHaveCount(1);
    const beforeLandingClear = overviewRequests.length;
    await homeUi.questionSearch(page).fill('');
    await expect(overviewUi.dots(page)).toHaveCount(3);
    await expect(page).toHaveURL((url) => !url.searchParams.has('q'));
    expect(overviewRequests).toHaveLength(beforeLandingClear);

    // Clearing on a scoped direct entry retains the type/chapter filters without another read.
    await page.goto(`${homePath(ws.id)}?type=MCQ&chapter=none&q=${encodeURIComponent('염소')}`);
    await expect(overviewUi.dots(page)).toHaveCount(1);
    const beforeScopedClear = overviewRequests.length;
    await homeUi.questionSearch(page).fill('');
    await expect(overviewUi.dots(page)).toHaveCount(3);
    await expect(page).toHaveURL(
      (url) =>
        !url.searchParams.has('q') &&
        url.searchParams.get('type') === 'MCQ' &&
        url.searchParams.get('chapter') === 'none',
    );
    expect(overviewRequests).toHaveLength(beforeScopedClear);
  },
);

test(
  'SEARCH-01-AC12 a dialog opened while the filtered heatmap is still loading stays open (search and filter)',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac12-race');
    const ws = await workspaceFactory.create(owner);
    for (const title of QUESTION_TITLES) {
      await createQuestion(owner, ws.id, mcqInput(title, ['예', '아니오']));
    }
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(3);
    const overviewApi = `/api/workspaces/${ws.id}/questions/overview`;
    // Hold every overview BFF read for the searched query or the type filter until released.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = 0;
    await page.route(
      (url) =>
        url.pathname === overviewApi &&
        (url.searchParams.get('q') === 'search01-ac12 chlorine' || url.searchParams.has('type')),
      async (route) => {
        held += 1;
        await released;
        await route.continue().catch(() => undefined);
      },
    );

    // The 문제 search commits, its BFF read is held, and the 문서 dialog opens meanwhile.
    await homeUi.questionSearch(page).fill('search01-ac12 chlorine');
    await expect.poll(() => held).toBeGreaterThan(0);
    await homeUi.openDocuments(page);
    await expect(homeUi.documentsDialog(page)).toBeVisible();
    release();
    // UX9: the Heatmap behind the modal dialog is hidden from assistive technology.
    await expect(homeBackgroundUi.dots(page)).toHaveCount(1);
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get('q') === 'search01-ac12 chlorine' &&
        url.searchParams.getAll('panel').includes('documents'),
    );
    await expect(homeUi.documentsDialog(page)).toBeVisible();
    await homeUi
      .documentsDialog(page)
      .getByRole('button', { name: /문서 관리 닫기|close/i })
      .click();
    await expect(homeUi.documentsDialog(page)).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });

    // The same for the type filter of "문제 설정".
    let releaseType: () => void = () => undefined;
    const typeReleased = new Promise<void>((resolve) => (releaseType = resolve));
    let typeHeld = 0;
    await page.route(
      (url) => url.pathname === overviewApi && url.searchParams.get('type') === 'MCQ',
      async (route) => {
        typeHeld += 1;
        await typeReleased;
        await route.continue().catch(() => undefined);
      },
    );
    await openSearchOptions(page, 'questions');
    await chooseFilter(
      page,
      homeUi.searchSettings(page, 'questions').getByRole('combobox', { name: /^(유형|type)$/i }),
      /객관식|multiple choice|mcq/i,
    );
    await closeSearchOptions(page, 'questions');
    await expect.poll(() => typeHeld).toBeGreaterThan(0);
    await homeUi.historyButton(page).click();
    const history = main(page).getByRole('dialog', { name: /^(이력|history)$/i });
    await expect(history).toBeVisible();
    releaseType();
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get('type') === 'MCQ' &&
        url.searchParams.get('q') === 'search01-ac12 chlorine' &&
        url.searchParams.getAll('panel').includes('history'),
    );
    await page.waitForTimeout(1_000); // the released re-read has landed by now
    await expect(history).toBeVisible();
    expect(new URL(page.url()).searchParams.getAll('panel')).toContain('history');
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  },
);

test(
  'SEARCH-01-AC12 the heatmap still filters when a dialog is opened and closed while the overview load is in flight',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac12-race2');
    const ws = await workspaceFactory.create(owner);
    for (const title of QUESTION_TITLES) {
      await createQuestion(owner, ws.id, mcqInput(title, ['예', '아니오']));
    }
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(3);
    const overviewApi = `/api/workspaces/${ws.id}/questions/overview`;
    const QUERY = 'search01-ac12 chlorine';
    let openGate: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => (openGate = resolve));
    let held = 0;
    await page.route(
      (url) => url.pathname === overviewApi && url.searchParams.get('q') === QUERY,
      async (route) => {
        held += 1;
        await opened;
        await route.continue().catch(() => undefined);
      },
    );

    await homeUi.questionSearch(page).fill(QUERY);
    await expect.poll(() => held).toBeGreaterThan(0);
    await homeUi.openDocuments(page);
    await expect(homeUi.documentsDialog(page)).toBeVisible();
    await homeUi
      .documentsDialog(page)
      .getByRole('button', { name: /문서 관리 닫기|close/i })
      .click();
    await expect(homeUi.documentsDialog(page)).toHaveCount(0);
    openGate();

    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(page).toHaveURL(
      (url) => url.searchParams.get('q') === QUERY && !url.searchParams.has('panel'),
    );
    await expect(homeUi.questionSearch(page)).toHaveValue(QUERY);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  },
);

test(
  'SEARCH-01-AC12 Korean IME composition does not filter until the composition ends',
  { tag: '@infra' },
  async ({ page, workspaceFactory, browserName }) => {
    const owner = await workspaceFactory.member('search01-ac12-ime');
    const ws = await workspaceFactory.create(owner);
    for (const title of QUESTION_TITLES) {
      await createQuestion(owner, ws.id, mcqInput(title, ['예', '아니오']));
    }

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(3);
    const box = homeUi.questionSearch(page);
    await box.fill('search01-ac12 ');
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'search01-ac12');

    // Compose "염" from its jamo. Chromium drives a real IME composition (CDP); WebKit gets the
    // same DOM events (compositionstart, input while composing, compositionend).
    const steps = ['ㅇ', '여', '염'];
    const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
    if (cdp) {
      for (const text of steps) {
        await cdp.send('Input.imeSetComposition', {
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
        });
        await page.waitForTimeout(150);
      }
    } else {
      await box.evaluate((el: HTMLInputElement, jamo: string[]) => {
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        const base = el.value;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        for (const text of jamo) {
          el.dispatchEvent(
            new CompositionEvent('compositionupdate', { bubbles: true, data: text }),
          );
          setter?.call(el, base + text);
          el.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              data: text,
              isComposing: true,
              inputType: 'insertCompositionText',
            }),
          );
        }
      }, steps);
    }
    await expect(box).toHaveValue('search01-ac12 염');
    // Well past the debounce: still composing, so nothing is filtered yet.
    await page.waitForTimeout(800);
    expect(new URL(page.url()).searchParams.get('q')).toBe('search01-ac12');
    await expect(overviewUi.dots(page)).toHaveCount(3);

    // The composition ends: the composed value filters.
    if (cdp) {
      await cdp.send('Input.insertText', { text: '염' });
    } else {
      await box.evaluate((el: HTMLInputElement) => {
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '염' }));
      });
    }
    await expect(box).toHaveValue('search01-ac12 염');
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'search01-ac12 염');
    await expect(overviewUi.dots(page)).toHaveCount(1);
  },
);

// Opens a share link, so it runs on the sharing fixtures (fixtures/sharing.ts): link cleanup,
// secret digests for `e2e:artifact-audit`, a redacted page text and redacted errors on failure.
sharingTest.describe('shared view', () => {
  sharingTest(
    'SEARCH-01-AC06 the shared view shows the keyword-only notice, also when nothing is found',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const owner = await workspaceFactory.member('search01-ac06-share');
      const ws = await workspaceFactory.create(owner);
      await uploadReadyBook(owner, ws.id, 'book-en');
      const link = await createShareLink(owner, ws.id);

      await openShareWithSecret(page, link.id, link.secret);
      await expect(sharedUi.readOnlyNotice(page)).toBeVisible();
      await expectFragmentRemoved(page, link.id);
      const notice = page.getByRole('status').filter({ hasText: DEGRADED_NOTICE });

      await sharedUi.searchBox(page).fill('chlorine');
      await sharedUi.searchBox(page).press('Enter');
      await expect(sharedUi.results(page).getByRole('listitem').first()).toBeVisible();
      await expect(notice).toHaveCount(0);

      await sharedUi.searchBox(page).fill(`chlorine ${EMBEDDING_FAILURE_MARKER}`);
      await sharedUi.searchBox(page).press('Enter');
      await expect(sharedUi.results(page).getByRole('listitem').first()).toBeVisible();
      await expect(notice).toBeVisible();

      await sharedUi.searchBox(page).fill(`${NONSENSE} ${EMBEDDING_FAILURE_MARKER}`);
      await sharedUi.searchBox(page).press('Enter');
      await expect(page.getByText('검색 결과가 없습니다.')).toBeVisible();
      await expect(notice).toBeVisible();
    },
  );
});

// UX7-SELECT: an iPhone (touch, mobile viewport). Desktop WebKit/Chromium still click after a
// cancelled touch pointerup, iOS Safari does not, so the test also models that: a click that
// follows a cancelled touch pointerup is swallowed, as on the device.
test.describe('SEARCH-01-AC08 touch', () => {
  const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 14'];
  test.use(iphone);

  test(
    'SEARCH-01-AC08 one tap on the selected chapter at the top of the open list closes it in the 문제 설정 popover',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const owner = await workspaceFactory.member('search01-ac08');
      const ws = await workspaceFactory.create(owner);
      // A question without a chapter adds the "챕터 없음" choice below "전체 챕터".
      await createQuestion(owner, ws.id, mcqInput('search01-ac08 문제', ['예', '아니오']));
      await page.addInitScript(() => {
        const w = window as unknown as { __cancelledTouchUps: number };
        w.__cancelledTouchUps = 0;
        let swallow = false;
        window.addEventListener('pointerup', (event) => {
          swallow = event.pointerType === 'touch' && event.defaultPrevented;
          if (swallow) w.__cancelledTouchUps += 1;
        });
        window.addEventListener(
          'click',
          (event) => {
            if (!swallow) return;
            swallow = false;
            event.preventDefault();
            event.stopImmediatePropagation();
          },
          true,
        );
      });
      const cancelledTouchUps = () =>
        page.evaluate(
          () => (window as unknown as { __cancelledTouchUps: number }).__cancelledTouchUps,
        );

      await signInAs(page, owner.user);
      await page.goto(homePath(ws.id));
      const popover = homeUi.searchSettings(page, 'questions');
      await expect(popover).toBeVisible();
      const chapter = popover.getByRole('combobox', { name: /^(챕터|chapter)$/i });
      await expect(chapter).toHaveText(/전체 챕터|all chapters/i);

      await chapter.tap();
      const list = page.getByRole('listbox');
      await expect(list).toBeVisible();
      const options = list.getByRole('option');
      await expect(options).toHaveCount(2);
      const selected = options.first();
      await expect(selected).toHaveText(/전체 챕터|all chapters/i);
      await expect(selected).toHaveAttribute('data-state', 'checked');

      await selected.tap();
      await expect(list).toBeHidden();
      await expect(chapter).toHaveAttribute('aria-expanded', 'false');
      await expect(chapter).toHaveText(/전체 챕터|all chapters/i);
      await expect(popover).toBeVisible();
      expect(page.url()).not.toContain('chapter=');
      expect(await cancelledTouchUps()).toBe(0);

      // Another choice still changes the filter on one tap.
      await chapter.tap();
      await list.getByRole('option', { name: /챕터 없음|no chapter/i }).tap();
      await expect(list).toBeHidden();
      await expect(page).toHaveURL((url) => url.searchParams.get('chapter') === 'none');
      await expect(chapter).toHaveText(/챕터 없음|no chapter/i);
      expect(await cancelledTouchUps()).toBe(0);
    },
  );
});

// UX7-SEARCH-2: question papers are found by the 문제 search only; the 본문 search leaves them
// out on the server (the English book uploaded as a 문제지 next to the Korean 교재; the query
// matches both texts).
const BOTH_BOOKS_QUERY = 'chlorine 염소';

interface SearchHit {
  readonly document_id: string;
  readonly document_type: string;
}

test(
  'SEARCH-01-AC13 the 본문 search leaves question papers out, on the server and in its document filter',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac13');
    const ws = await workspaceFactory.create(owner);
    const bookId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const paper = await uploadPdf(owner, ws.id, EN, 'question_paper');
    await waitForJob(owner, paper.jobId);
    const docs: readonly (Awaited<ReturnType<typeof listDocuments>>[number] & {
      readonly active_revision_id?: string | null;
    })[] = await listDocuments(owner, ws.id);
    const paperDoc = docs.find((d) => d.id === paper.documentId);
    const bookDoc = docs.find((d) => d.id === bookId);
    expect(paperDoc?.active_revision_id, 'the paper is published').toBeTruthy();
    expect(paperDoc?.document_type).toBe('question_paper');
    await createQuestion(owner, ws.id, mcqInput('search01-ac13 chlorine 문제', ['예', '아니오']));
    await createQuestion(owner, ws.id, mcqInput('search01-ac13 다른 문제', ['예', '아니오']));

    // API: no question-paper hit, whatever the request asks for.
    const searchApi = async (body: Record<string, unknown>) =>
      (
        await owner.api.ok<{ items: SearchHit[] }>(
          'POST',
          `/workspaces/${ws.id}/search`,
          { query: BOTH_BOOKS_QUERY, mode: 'keyword', limit: 50, ...body },
          [200],
        )
      ).items;
    const plain = await searchApi({});
    expect(plain.length).toBeGreaterThan(0);
    expect(new Set(plain.map((h) => h.document_id))).toEqual(new Set([bookId]));
    const asked = await searchApi({ include_question_papers: true });
    expect(asked.map((h) => h.document_id)).toEqual(plain.map((h) => h.document_id));
    expect(asked.some((h) => h.document_type === 'question_paper')).toBe(false);
    expect(
      await searchApi({ document_ids: [paper.documentId], include_question_papers: true }),
    ).toEqual([]);

    await signInAs(page, owner.user);
    await page.goto(searchPath(ws.id));

    // The document filter lists the book only.
    const popover = await openSearchOptions(page);
    await searchUi.documentFilter(page).click();
    const options = page.getByRole('option');
    await expect(options.filter({ hasText: bookDoc?.title ?? bookId })).toHaveCount(1);
    await expect(options.filter({ hasText: paperDoc?.title ?? paper.documentId })).toHaveCount(0);
    await expect(options.filter({ hasText: /문제지|question paper/i })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(popover).toBeVisible();
    await closeSearchOptions(page);

    // The 본문 results are the book's only, as many as the API's (the page asks for 20).
    await runSearch(page, BOTH_BOOKS_QUERY, 'keyword');
    const items = searchUi.resultItems(page);
    await expect(items.first()).toBeVisible();
    await expect(items).toHaveCount(Math.min(plain.length, 20));
    await expect(items.filter({ hasText: /chlorine/i })).toHaveCount(0);

    // The 문제 search on the home still filters the questions.
    await page.goto(homePath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(2);
    await homeUi.questionSearch(page).fill('chlorine');
    await expect(overviewUi.dots(page)).toHaveCount(1);
  },
);

test(
  'SEARCH-01-AC13 a workspace whose only published PDF is a question paper has no body to search',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac13-paper-only');
    const ws = await workspaceFactory.create(owner);
    const paper = await uploadPdf(owner, ws.id, EN, 'question_paper');
    await waitForJob(owner, paper.jobId);

    await signInAs(page, owner.user);
    await page.goto(searchPath(ws.id));
    const submit = searchUi.submit(page);
    await expect(submit).toBeDisabled();
    await expect(homeUi.contentSearchMessage(page)).toHaveText(NO_BODY);
    await expect(submit).toHaveAccessibleDescription(NO_BODY);
  },
);
