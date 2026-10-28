// SEARCH-01 — 통합 검색 (the workspace home header, `/workspaces/:workspaceId?q=`; most tests use the
// content-only scope `?scope=content`, which the old `/search` route redirects to), docs/screens/search.md;
// search flow docs/architecture.md §4 (keyword | semantic | hybrid, server-side workspace and
// published-revision filters, SourceLocation = page + block + revision).
//
// Each test indexes synthetic books (tests/fixtures/pdfs) into its own workspace through the
// public upload flow. E2E runs the deterministic fake embedder/reranker (docs/e2e-strategy.md §3):
// these tests check the UI/API contract and source mapping, not retrieval quality (eval/ does).
// Queries come from tests/fixtures/pdfs/retrieval-seed.json (q-ko-01 → section ch2-s2, page 4).
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

test(
  'SEARCH-01-AC07 the unified header search filters questions and/or finds body text by its scope checkboxes',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac07');
    const ws = await workspaceFactory.create(owner);
    await uploadReadyBook(owner, ws.id, 'book-en');
    await createQuestion(
      owner,
      ws.id,
      mcqInput('search01-ac07 chlorine 소독 문제', ['예', '아니오']),
    );
    await createQuestion(owner, ws.id, mcqInput('search01-ac07 다른 문제', ['예', '아니오']));

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(2);
    // Icon-only submit with an accessible name.
    await expect(searchUi.submit(page)).toHaveText('');
    await expect(searchUi.submit(page)).toBeEnabled();
    // UX6: no "검색 옵션" popover; the 문제 · 본문 checkboxes sit right under the box (both on).
    await expect(
      main(page).getByRole('button', { name: /^(검색 옵션|search options)$/i }),
    ).toHaveCount(0);
    await expect(homeUi.scopeQuestions(page)).toBeChecked();
    await expect(homeUi.scopeContent(page)).toBeChecked();
    const boxRect = await searchUi.box(page).boundingBox();
    for (const checkbox of [homeUi.scopeQuestions(page), homeUi.scopeContent(page)]) {
      const rect = await checkbox.boundingBox();
      expect(rect && boxRect && rect.y >= boxRect.y + boxRect.height - 1).toBe(true);
    }

    // Each scope's "설정" opens its own settings popover: 문제 by click…
    const questionSettings = homeUi.scopeSettingsButton(page, 'questions');
    await expect(questionSettings).toHaveAttribute('aria-expanded', 'false');
    await questionSettings.click();
    const questionPopover = homeUi.scopeSettings(page, 'questions');
    await expect(questionPopover).toBeVisible();
    await expect(questionSettings).toHaveAttribute('aria-expanded', 'true');
    await expect(
      questionPopover.getByRole('combobox', { name: /^(챕터|chapter)$/i }),
    ).toBeVisible();
    await expect(questionPopover.getByRole('combobox', { name: /^(유형|type)$/i })).toBeVisible();
    await expect(questionPopover.getByRole('radiogroup')).toHaveCount(0);
    await closeSearchOptions(page, 'questions');
    await expect(questionSettings).toBeFocused();

    // …본문 by keyboard: search mode, document and section filters only.
    const bodySettings = homeUi.scopeSettingsButton(page, 'body');
    await bodySettings.focus();
    await page.keyboard.press('Enter');
    const bodyPopover = homeUi.scopeSettings(page, 'body');
    await expect(bodyPopover).toBeVisible();
    await expect(bodySettings).toHaveAttribute('aria-expanded', 'true');
    await expect(
      bodyPopover.getByRole('radiogroup', { name: /검색 방식|search mode/i }),
    ).toBeVisible();
    await expect(bodyPopover.getByRole('combobox', { name: /^(문서|document)$/i })).toBeVisible();
    await expect(bodyPopover.getByRole('combobox', { name: /^(챕터|chapter)$/i })).toHaveCount(0);
    // UX4: no question-paper toggle.
    await expect(page.getByRole('checkbox', { name: /문제지|question papers?/i })).toHaveCount(0);
    await closeSearchOptions(page, 'body');
    await expect(bodySettings).toBeFocused();

    // Both (default): the heatmap is filtered and the body results appear.
    await searchUi.box(page).fill('chlorine');
    await searchUi.submit(page).click();
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(searchUi.resultsRegion(page)).toBeVisible();
    await expect(
      searchUi
        .resultItems(page)
        .filter({ hasText: /chlorine/i })
        .first(),
    ).toBeVisible();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get('q') === 'chlorine' && url.searchParams.get('papers') === '1',
    );

    // 문제 only: no body results.
    await homeUi.scopeContent(page).click();
    await expect(page).toHaveURL((url) => url.searchParams.get('scope') === 'questions');
    await expect(searchUi.resultsRegion(page)).toHaveCount(0);
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(searchUi.submit(page)).toBeEnabled();

    // 본문 only: the heatmap is not filtered, the body results are back.
    await homeUi.scopeContent(page).click();
    await homeUi.scopeQuestions(page).click();
    await expect(page).toHaveURL((url) => url.searchParams.get('scope') === 'content');
    // Question papers are searched only while 문제 is checked.
    await expect(page).toHaveURL((url) => !url.searchParams.has('papers'));
    await expect(overviewUi.dots(page)).toHaveCount(2);
    await expect(searchUi.resultItems(page).first()).toBeVisible();

    // The state is in the URL: a reload shows the same search.
    await page.reload();
    await expect(searchUi.box(page)).toHaveValue('chlorine');
    await expect(homeUi.scopeQuestions(page)).not.toBeChecked();
    await expect(homeUi.scopeContent(page)).toBeChecked();
    await expect(searchUi.resultItems(page).first()).toBeVisible();
    await expect(overviewUi.dots(page)).toHaveCount(2);

    await searchUi.closeResults(page).click();
    await expect(searchUi.resultsRegion(page)).toHaveCount(0);
    await expect(page).toHaveURL((url) => !url.searchParams.has('q'));
    await expect(searchUi.box(page)).toHaveValue('');
  },
);

const NOTHING_TO_SEARCH = /검색할 문제와 본문이 없|nothing to search/i;
const NO_SCOPE = /검색 범위를 하나 이상|choose at least one/i;
const NO_QUESTIONS = /검색할 문제가 없|no questions to search/i;
const NO_BODY = /검색할 본문이 없|no (body|documents) to search/i;

test(
  'SEARCH-01-AC07 the search button is disabled with a stated reason when the checked scopes have nothing to search',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac07-disabled');
    const ws = await workspaceFactory.create(owner);

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    const submit = searchUi.submit(page);
    const message = homeUi.searchMessage(page);
    // An empty workspace: both scopes stay checked (the default) but there is nothing to search.
    await expect(homeUi.scopeQuestions(page)).toBeChecked();
    await expect(homeUi.scopeContent(page)).toBeChecked();
    await expect(submit).toBeDisabled();
    await expect(message).toHaveText(NOTHING_TO_SEARCH);
    await expect(submit).toHaveAccessibleDescription(NOTHING_TO_SEARCH);
    // Enter does not search either.
    await searchUi.box(page).fill('chlorine');
    await searchUi.box(page).press('Enter');
    await expect(page).toHaveURL((url) => !url.searchParams.has('q'));

    // Questions but no published document: both checked searches the questions only.
    await createQuestion(owner, ws.id, mcqInput('search01-ac07 chlorine 문제', ['예', '아니오']));
    await createQuestion(owner, ws.id, mcqInput('search01-ac07 다른 문제', ['예', '아니오']));
    await page.reload();
    await expect(overviewUi.dots(page)).toHaveCount(2);
    await expect(submit).toBeEnabled();
    await expect(message).toHaveText(/본문이 없어 문제만 검색|questions only/i);

    // 본문 only, without a document: disabled.
    await homeUi.scopeQuestions(page).click();
    await expect(page).toHaveURL((url) => url.searchParams.get('scope') === 'content');
    await expect(submit).toBeDisabled();
    await expect(message).toHaveText(NO_BODY);
    await expect(submit).toHaveAccessibleDescription(NO_BODY);

    // Both off: disabled until a scope is chosen again.
    await homeUi.scopeContent(page).click();
    await expect(page).toHaveURL((url) => url.searchParams.get('scope') === 'none');
    await expect(homeUi.scopeContent(page)).not.toBeChecked();
    await expect(submit).toBeDisabled();
    await expect(message).toHaveText(NO_SCOPE);
    await expect(submit).toHaveAccessibleDescription(NO_SCOPE);

    // 문제 only, with questions: searches again, without a message.
    await homeUi.scopeQuestions(page).click();
    await expect(page).toHaveURL((url) => url.searchParams.get('scope') === 'questions');
    await expect(submit).toBeEnabled();
    await expect(message).toHaveText('');
    await searchUi.box(page).fill('chlorine');
    await submit.click();
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'chlorine');
    await expect(overviewUi.dots(page)).toHaveCount(1);
  },
);

test(
  'SEARCH-01-AC07 a workspace with a document but no questions searches the body only and disables a 문제-only search',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac07-body');
    const ws = await workspaceFactory.create(owner);
    await uploadReadyBook(owner, ws.id, 'book-en');

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id, 'scope=questions'));
    const submit = searchUi.submit(page);
    const message = homeUi.searchMessage(page);
    await expect(homeUi.scopeQuestions(page)).toBeChecked();
    await expect(homeUi.scopeContent(page)).not.toBeChecked();
    await expect(submit).toBeDisabled();
    await expect(message).toHaveText(NO_QUESTIONS);
    await expect(submit).toHaveAccessibleDescription(NO_QUESTIONS);

    // Both checked: the body is searched alone, and the screen says so.
    await homeUi.scopeContent(page).click();
    await expect(page).toHaveURL((url) => !url.searchParams.has('scope'));
    await expect(submit).toBeEnabled();
    await expect(message).toHaveText(/문제가 없어 본문만 검색|body only/i);
    await searchUi.box(page).fill('chlorine');
    await searchUi.box(page).press('Enter');
    await expect(
      searchUi
        .resultItems(page)
        .filter({ hasText: /chlorine/i })
        .first(),
    ).toBeVisible();
  },
);

test(
  'SEARCH-01-AC07 browser Back restores the earlier search in the box and the results',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search01-ac07-back');
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
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'evaporation');
    await expect(items.filter({ hasText: /evaporat/i }).first()).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get('q') === 'chlorine' && !url.searchParams.has('panel'),
    );
    await expect(homeUi.documentsDialog(page)).toHaveCount(0);
    await expect(searchUi.box(page)).toHaveValue('chlorine');
    // The restored search runs again: every listed hit is a chlorine hit once it settles.
    await expect(items.filter({ hasNotText: /chlorine/i })).toHaveCount(0);
    await expect(items.first()).toBeVisible();
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
