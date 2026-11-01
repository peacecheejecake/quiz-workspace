// SEARCH-01 — 문제 검색·본문 검색 (the workspace home header, `/workspaces/:workspaceId?q=&text=`; UX7-SEARCH
// split the unified box: the 문제 search filters the heatmap live, the 본문 search is collapsed behind
// its disclosure and runs on Enter; the old `/search?q=` route redirects to `text=`), docs/screens/search.md;
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
  uploadReadyBook,
  type Problem,
  type SearchItem,
} from '../fixtures/test.ts';
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

    // Non-modal FloatingSidePanel next to the results: paragraph-complete excerpt + page.
    const panel = searchUi.excerptPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel).not.toHaveAttribute('aria-modal', 'true');
    await expect(panel).toContainText(CHLORINE_EN.text);
    await expect(panel).toContainText(pageLabel(CHLORINE_PAGE));
    await searchUi.box(page).click();
    await expect(searchUi.box(page)).toBeFocused();
    await expect(panel).toBeVisible();

    await searchUi.openInPdf(panel).click();
    await expect(page).toHaveURL(
      (url) => url.pathname === `/workspaces/${ws.id}/documents/${documentId}`,
    );
    await expect(editorUi.currentPage(page)).toHaveValue(String(CHLORINE_PAGE));
    await expect(editorUi.highlight(page)).toBeVisible();
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
  'SEARCH-01-AC09 the 문제 and 본문 searches are separate inputs with their own settings, URL keys and results',
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
    // No unified box, no scope checkboxes, no "검색 옵션" popover (UX7-SEARCH).
    await expect(main(page).getByRole('checkbox', { name: SCOPE_CHECKBOX })).toHaveCount(0);
    await expect(
      main(page).getByRole('button', { name: /^(검색 옵션|search options)$/i }),
    ).toHaveCount(0);
    const questionBox = homeUi.questionSearch(page);
    await expect(questionBox).toBeVisible();
    await expect(questionBox).toBeEnabled();

    // 문제 설정 (next to the 문제 search) by click: chapter and type only.
    const questionSettings = homeUi.searchSettingsButton(page, 'questions');
    await expect(questionSettings).toHaveAttribute('aria-expanded', 'false');
    await questionSettings.click();
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

    // 본문 설정 (inside the 본문 search) by keyboard: mode, document and section filters only.
    await openContentSearch(page);
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

    // The 문제 search filters the heatmap only: no body results, the 본문 box stays empty.
    await questionBox.fill('chlorine');
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'chlorine');
    await expect(searchUi.resultsRegion(page)).toHaveCount(0);
    await expect(searchUi.box(page)).toHaveValue('');

    // The 본문 search finds body text and leaves the heatmap's search alone.
    await searchUi.box(page).fill('chlorine');
    await searchUi.submit(page).click();
    await expect(
      searchUi
        .resultItems(page)
        .filter({ hasText: /chlorine/i })
        .first(),
    ).toBeVisible();
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get('text') === 'chlorine' && url.searchParams.get('q') === 'chlorine',
    );
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(questionBox).toHaveValue('chlorine');

    // Changing the 문제 search keeps the body results.
    await questionBox.fill('다른');
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === '다른');
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(searchUi.resultItems(page).first()).toBeVisible();
    await expect(searchUi.box(page)).toHaveValue('chlorine');
    await questionBox.fill('');
    await expect(overviewUi.dots(page)).toHaveCount(2);
    await expect(page).toHaveURL(
      (url) => !url.searchParams.has('q') && url.searchParams.get('text') === 'chlorine',
    );

    // Both states are in the URL: a reload shows the same searches.
    await questionBox.fill('chlorine');
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await page.reload();
    await expect(homeUi.questionSearch(page)).toHaveValue('chlorine');
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(searchUi.box(page)).toHaveValue('chlorine');
    await expect(searchUi.resultItems(page).first()).toBeVisible();

    // "검색 결과 닫기" clears the 본문 search only.
    await searchUi.closeResults(page).click();
    await expect(searchUi.resultsRegion(page)).toHaveCount(0);
    await expect(page).toHaveURL(
      (url) => !url.searchParams.has('text') && url.searchParams.get('q') === 'chlorine',
    );
    await expect(searchUi.box(page)).toHaveValue('');
    await expect(homeUi.questionSearch(page)).toHaveValue('chlorine');
    await expect(overviewUi.dots(page)).toHaveCount(1);
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
    // No published document: the 본문 search button is disabled, Enter does not search either.
    await openContentSearch(page);
    const submit = searchUi.submit(page);
    await expect(submit).toBeDisabled();
    await expect(homeUi.contentSearchMessage(page)).toHaveText(NO_BODY);
    await expect(submit).toHaveAccessibleDescription(NO_BODY);
    await searchUi.box(page).fill('chlorine');
    await searchUi.box(page).press('Enter');
    await expect(searchUi.resultsRegion(page)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has('text')).toBe(false);

    // Questions now: the 문제 search works, the 본문 search is still disabled.
    await createQuestion(owner, ws.id, mcqInput('search01-ac09 chlorine 문제', ['예', '아니오']));
    await createQuestion(owner, ws.id, mcqInput('search01-ac09 다른 문제', ['예', '아니오']));
    await page.reload();
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
  'SEARCH-01-AC09 browser Back restores the earlier body search, and old scope URLs move to text=',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac09-back');
    const ws = await workspaceFactory.create(owner);
    await uploadReadyBook(owner, ws.id, 'book-en');

    await signInAs(page, owner.user);
    await page.goto(searchPath(ws.id));
    await runSearch(page, 'chlorine', 'keyword');
    const items = searchUi.resultItems(page);
    await expect(items.filter({ hasText: /chlorine/i }).first()).toBeVisible();
    // A dialog opens on a new history entry; a second search replaces that entry's query.
    await homeUi.documentsButton(page).click();
    await expect(homeUi.documentsDialog(page)).toBeVisible();
    await searchUi.box(page).fill('evaporation');
    await searchUi.box(page).press('Enter');
    await expect(page).toHaveURL((url) => url.searchParams.get('text') === 'evaporation');
    await expect(items.filter({ hasText: /evaporat/i }).first()).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get('text') === 'chlorine' && !url.searchParams.has('panel'),
    );
    await expect(homeUi.documentsDialog(page)).toHaveCount(0);
    await expect(searchUi.box(page)).toHaveValue('chlorine');
    await expect(items.filter({ hasNotText: /chlorine/i })).toHaveCount(0);
    await expect(items.first()).toBeVisible();

    // The unified search's body-only URL (UX6) and the pre-UX3c route open the 본문 search.
    await page.goto(homePath(ws.id, 'q=chlorine&scope=content&mode=keyword'));
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get('text') === 'chlorine' &&
        !url.searchParams.has('q') &&
        !url.searchParams.has('scope'),
    );
    await expect(searchUi.box(page)).toHaveValue('chlorine');
    await expect(homeUi.questionSearch(page)).toHaveValue('');
    await expect(items.first()).toBeVisible();
    await page.goto(`/workspaces/${ws.id}/search?q=evaporation&mode=keyword`);
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/workspaces/${ws.id}` &&
        url.searchParams.get('text') === 'evaporation' &&
        !url.searchParams.has('q'),
    );
    await expect(items.filter({ hasText: /evaporat/i }).first()).toBeVisible();
  },
);

test(
  'SEARCH-01-AC10 the body search is collapsed by default and opens with its disclosure button',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac10');
    const ws = await workspaceFactory.create(owner);

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    const toggle = homeUi.contentSearchToggle(page);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const controlled = await toggle.getAttribute('aria-controls');
    expect(controlled).toBeTruthy();
    expect(await page.locator(`[id="${controlled}"]`).count()).toBe(1);
    await expect(searchUi.box(page)).toBeHidden();
    await expect(homeUi.searchSettingsButton(page, 'body')).toBeHidden();
    await expect(searchUi.submit(page)).toBeHidden();

    // Mouse: opens, focus moves into the 본문 search box.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(`[id="${controlled}"]`)).toBeVisible();
    await expect(searchUi.box(page)).toBeVisible();
    await expect(searchUi.box(page)).toBeFocused();
    await expect(homeUi.searchSettingsButton(page, 'body')).toBeVisible();
    await searchUi.box(page).fill('정수장');

    // Keyboard: closes and reopens; the typed query is kept.
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(searchUi.box(page)).toBeHidden();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(searchUi.box(page)).toHaveValue('정수장');

    // A body search in the URL opens it expanded.
    await page.goto(homePath(ws.id, 'text=chlorine'));
    await expect(homeUi.contentSearchToggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(searchUi.box(page)).toHaveValue('chlorine');
    await page.goto(homePath(ws.id));
    await expect(homeUi.contentSearchToggle(page)).toHaveAttribute('aria-expanded', 'false');
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
  'SEARCH-01-AC11 clicking anywhere on a body result opens its text around the keyword on the right; the keyboard does the same',
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

    // Mouse on the excerpt paragraph (not the title) of the second hit.
    const second = items.nth(1);
    const secondText = (await searchUi.excerpt(second).innerText()).replace(/…/g, '').trim();
    await searchUi.excerpt(second).click();
    await expect(panel).toBeVisible();
    await expect(panel).not.toHaveAttribute('aria-modal', 'true');
    await expect(panel).toContainText(secondText.slice(0, 30));
    await expectMarkedKeyword(panel, /water/i);
    await expect(second.getByRole('button').first()).toHaveAttribute('aria-current', 'true');
    // On the right of the results.
    const panelBox = await panel.boundingBox();
    const listBox = await searchUi.results(page).boundingBox();
    expect(panelBox && listBox && panelBox.x >= listBox.x + listBox.width - 1).toBe(true);

    // Keyboard: the first hit's title button with Enter switches the panel to it.
    const first = items.first();
    const firstText = (await searchUi.excerpt(first).innerText()).replace(/…/g, '').trim();
    await first.getByRole('button').first().focus();
    await page.keyboard.press('Enter');
    await expect(panel).toContainText(firstText.slice(0, 30));
    await expect(first.getByRole('button').first()).toHaveAttribute('aria-current', 'true');
    await expect(second.getByRole('button').first()).not.toHaveAttribute('aria-current', 'true');
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
      await homeUi.contentSearchToggle(page).tap();
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

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(3);
    const box = homeUi.questionSearch(page);
    const historyLength = await page.evaluate(() => window.history.length);

    // Typed key by key, never Enter: the heatmap follows.
    await box.pressSequentially('search01-ac12', { delay: 20 });
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'search01-ac12');
    await expect(overviewUi.dots(page)).toHaveCount(3);
    await box.pressSequentially(' chlorine', { delay: 20 });
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'search01-ac12 chlorine');
    await expect(box).toHaveValue('search01-ac12 chlorine');

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
    await box.press('Backspace');
    await expect(overviewUi.dots(page)).toHaveCount(1);

    // Fast typing never loses a character, and the last query wins over an answer that is late:
    // the re-read for the shorter query is held back until after the longer one.
    await box.fill('');
    await expect(overviewUi.dots(page)).toHaveCount(3);
    let held = 0;
    await page.route(
      (url) =>
        url.pathname === `/workspaces/${ws.id}` && url.searchParams.get('q') === 'search01-ac12',
      async (route) => {
        held += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.continue().catch(() => undefined);
      },
    );
    await box.pressSequentially('search01-ac12', { delay: 0 });
    await expect.poll(() => held).toBeGreaterThan(0);
    await box.pressSequentially(' 염소', { delay: 0 });
    await expect(box).toHaveValue('search01-ac12 염소');
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'search01-ac12 염소');
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await page.waitForTimeout(2_000); // the held answer arrives (or is dropped) by now
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(box).toHaveValue('search01-ac12 염소');
    await page.unrouteAll({ behavior: 'ignoreErrors' });

    // Clearing shows every question; typing never added history entries.
    await box.fill('');
    await expect(overviewUi.dots(page)).toHaveCount(3);
    await expect(page).toHaveURL((url) => !url.searchParams.has('q'));
    expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
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
    const home = `/workspaces/${ws.id}`;
    // Hold every heatmap re-read for the searched query or the type filter until released.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = 0;
    await page.route(
      (url) =>
        url.pathname === home &&
        (url.searchParams.get('q') === 'search01-ac12 chlorine' || url.searchParams.has('type')),
      async (route) => {
        held += 1;
        await released;
        await route.continue().catch(() => undefined);
      },
    );

    // The 문제 search commits, its re-read is held, and the 문서 dialog opens meanwhile.
    await homeUi.questionSearch(page).fill('search01-ac12 chlorine');
    await expect.poll(() => held).toBeGreaterThan(0);
    await homeUi.documentsButton(page).click();
    await expect(homeUi.documentsDialog(page)).toBeVisible();
    release();
    await expect(overviewUi.dots(page)).toHaveCount(1);
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
      (url) => url.pathname === home && url.searchParams.get('type') === 'MCQ',
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
      await homeUi.searchSettingsButton(page, 'questions').tap();
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
