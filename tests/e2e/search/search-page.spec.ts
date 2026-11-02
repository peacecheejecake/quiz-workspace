// SEARCH-02 — the 본문 search page `/workspaces/:id/search` (docs/screens/search-page.md): entered
// from the home header's `본문 검색` icon link (before `이력`); the home keeps only the 문제 search.
// Search rules, results and the excerpt panel are SEARCH-01's (search.spec.ts); the panel is modal
// here (HOMEDLG-01). UI contract: fixtures/ux9-pages.ts `searchPageUi` + workspace-ui.ts `searchUi`.
//
// Each test indexes synthetic books into its own workspace (deterministic fake embedder/reranker,
// docs/e2e-strategy.md §3).
import { devices, type Locator, type Page } from '@playwright/test';
import {
  block,
  book,
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
  outlineNodeId,
  overviewUi,
  questionPaper,
  searchUi,
  section,
  seedMembership,
  signInAs,
  test,
  uploadPdf,
  uploadReadyBook,
  waitForJob,
  type Problem,
} from '../fixtures/test.ts';
import {
  homeBackgroundUi,
  isBlocked,
  paperOnlyWorkspace,
  searchPagePath,
  searchPageUi,
} from '../fixtures/ux9-pages.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 2 * JOB_TIMEOUT_MS + 60_000 });

const EN = book('book-en');
const HANGUL = /[가-힣]/;
const NO_BODY =
  /검색할 본문이 없습니다\. 문서를 먼저 등록하고 발행하세요|no (body|documents) to search/i;
const RANDOM_ID = '00000000-0000-4000-8000-000000000000';

/** The page reached from the home: title, back link, breadcrumb (QOV-01-AC13 rules). */
async function expectSearchPage(page: Page, workspace: { id: string; name: string }) {
  await expect(page).toHaveURL((url) => url.pathname === searchPagePath(workspace.id));
  await expect(searchPageUi.heading(page)).toBeVisible();
  await expect(searchPageUi.backLink(page)).toBeVisible();
  const nav = searchPageUi.breadcrumb(page);
  await expect(nav.getByRole('link', { name: workspace.name, exact: true })).toHaveAttribute(
    'href',
    homePath(workspace.id),
  );
  await expect(nav.locator('[aria-current="page"]')).toHaveText(/^(본문 검색|body search)$/i);
  const [navBox, titleBox] = await Promise.all([
    nav.boundingBox(),
    searchPageUi.heading(page).boundingBox(),
  ]);
  expect(navBox && titleBox && titleBox.y - (navBox.y + navBox.height)).toBeGreaterThanOrEqual(12);
}

/** Accessible names of the home's buttons and links, in document order. */
async function controlNames(scope: Locator): Promise<string[]> {
  return scope
    .locator('a[href], button')
    .evaluateAll((els) =>
      els.map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()),
    );
}

test(
  'SEARCH-02-AC01 the home header has a 본문 검색 icon link before 이력 that opens the search page; Back returns to the home address',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search02-ac01');
    const viewer = await workspaceFactory.member('search02-ac01-viewer');
    const ws = await workspaceFactory.create(owner);
    seedMembership(ws.id, viewer.user.id, 'viewer');
    await uploadReadyBook(owner, ws.id, 'book-en');
    await createQuestion(owner, ws.id, mcqInput('search02-ac01 chlorine 문제', ['예', '아니오']));
    await createQuestion(owner, ws.id, mcqInput('search02-ac01 다른 문제', ['예', '아니오']));

    await signInAs(page, viewer.user);
    await page.goto('/workspaces');
    // The home with a 문제 search in its address (kept when coming back).
    const home = homePath(ws.id, 'q=chlorine');
    await page.goto(home);
    await expect(overviewUi.dots(page)).toHaveCount(1);

    // The icon link sits right before 이력, shows no text, names itself and has a tooltip.
    const entry = searchPageUi.homeEntry(page);
    await expect(entry).toBeVisible();
    await expect(entry).toHaveAttribute('href', new RegExp(`^${searchPagePath(ws.id)}`));
    expect((await entry.innerText()).trim(), 'icon only').toBe('');
    const names = await controlNames(main(page));
    const historyAt = names.findIndex((n) => /^(이력|history)$/i.test(n));
    expect(historyAt, 'the 이력 button').toBeGreaterThan(0);
    expect(names[historyAt - 1]).toMatch(/^(본문 검색|body search|content search)$/i);
    await entry.hover();
    await expect(page.getByRole('tooltip')).toHaveText(/^(본문 검색|body search|content search)$/i);
    await page.mouse.move(0, 0);
    await entry.focus();
    await expect(page.getByRole('tooltip')).toHaveText(/^(본문 검색|body search|content search)$/i);
    // The home has no 본문 search left: no disclosure, box or results; 문제 search stays.
    await expect(homeUi.contentSearchToggle(page)).toHaveCount(0);
    await expect(main(page).getByRole('button', { name: /본문 검색|body search/i })).toHaveCount(0);
    await expect(searchUi.box(page)).toHaveCount(0);
    await expect(searchUi.resultsRegion(page)).toHaveCount(0);
    await expect(homeUi.questionSearch(page)).toHaveValue('chlorine');

    // Click: the page, its box focused.
    await entry.click();
    await expectSearchPage(page, ws);
    await expect(searchPageUi.box(page)).toBeFocused();
    await expect(searchPageUi.intro(page)).toBeVisible();
    // Keyboard Enter does the same.
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === homePath(ws.id));
    await searchPageUi.homeEntry(page).focus();
    await page.keyboard.press('Enter');
    await expectSearchPage(page, ws);
    await expect(searchPageUi.box(page)).toBeFocused();

    // A search writes `text` in place (no new history entry) and shows the results.
    const entries = await page.evaluate(() => window.history.length);
    await searchPageUi.box(page).fill('chlorine');
    await searchPageUi.box(page).press('Enter');
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === searchPagePath(ws.id) && url.searchParams.get('text') === 'chlorine',
    );
    await expect(
      searchUi
        .resultItems(page)
        .filter({ hasText: /chlorine/i })
        .first(),
    ).toBeVisible();
    expect(await page.evaluate(() => window.history.length)).toBe(entries);

    // Back link: the home address it came from; Forward: the same search again.
    await searchPageUi.backLink(page).click();
    await expect(page).toHaveURL(
      (url) => url.pathname === homePath(ws.id) && url.searchParams.get('q') === 'chlorine',
    );
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await page.goForward();
    await expect(page).toHaveURL((url) => url.searchParams.get('text') === 'chlorine');
    await expect(searchPageUi.box(page)).toHaveValue('chlorine');
    await expect(searchUi.resultItems(page).first()).toBeVisible();
  },
);

/** Searches `query` on the page with only `documentTitle` chosen in 본문 설정. */
async function searchInDocument(page: Page, query: string, documentTitle: string): Promise<void> {
  await searchPageUi.settingsButton(page).click();
  const popover = searchPageUi.settings(page);
  await expect(popover).toBeVisible();
  await searchUi.mode(page, 'keyword').check();
  await searchUi.documentFilter(page).click();
  const options = page.getByRole('option');
  await expect(options.filter({ hasText: /questions-ko|문제지|question paper/i })).toHaveCount(0);
  await options.filter({ hasText: documentTitle }).click();
  await expect(async () => {
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden({ timeout: 1_000 });
  }).toPass();
  await searchPageUi.box(page).fill(query);
  await searchPageUi.box(page).press('Enter');
}

async function setupTwoBooks(workspaceFactory: WorkspaceFactory, label: string) {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const enId = await uploadReadyBook(owner, ws.id, 'book-en');
  await uploadReadyBook(owner, ws.id, 'book-ko');
  const paper = await uploadPdf(owner, ws.id, questionPaper(), 'question_paper');
  await waitForJob(owner, paper.jobId);
  const docs = await listDocuments(owner, ws.id);
  const enTitle = docs.find((d) => d.id === enId)?.title ?? 'book-en';
  return { owner, ws, enId, enTitle };
}

test(
  'SEARCH-02-AC02 a document-scoped search opens its excerpts in a modal panel with 다음 결과; PDF에서 보기 and Back return to the same search',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, ws, enId, enTitle } = await setupTwoBooks(workspaceFactory, 'search02-ac02');

    await signInAs(page, owner.user);
    await page.goto(searchPagePath(ws.id));
    await expect(searchPageUi.heading(page)).toBeVisible();
    await searchInDocument(page, 'water', enTitle);
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === searchPagePath(ws.id) &&
        url.searchParams.get('text') === 'water' &&
        url.searchParams.get('document') === enId,
    );
    const items = searchUi.resultItems(page);
    await expect(items.nth(1)).toBeVisible();
    for (const text of await searchUi.excerpt(items).allInnerTexts())
      expect(text, 'only the chosen (English) book').not.toMatch(HANGUL);

    // The excerpt panel is modal: the results behind it are cut off and do not move aside.
    const listBefore = await searchUi.results(page).boundingBox();
    const firstText = (await searchUi.excerpt(items.first()).innerText()).replace(/…/g, '').trim();
    const secondText = (await searchUi.excerpt(items.nth(1)).innerText()).replace(/…/g, '').trim();
    await searchUi.excerpt(items.first()).click();
    const panel = searchUi.excerptPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(await isBlocked(homeBackgroundUi.searchResults(page)), 'results are inert').toBe(true);
    expect(await homeBackgroundUi.searchResults(page).boundingBox()).toEqual(listBefore);
    await expect(panel).toContainText(firstText.slice(0, 30));
    await expect(panel).toContainText(enTitle);
    await expect(panel).toContainText(/p\.\s*\d+|\d+\s*쪽|페이지\s*\d+|page \d+/i);
    await expect(panel.locator('mark').filter({ hasText: /water/i }).first()).toBeVisible();

    // 다음 결과 shows the next result's excerpt; 이전 결과 is disabled on the first.
    await expect(searchPageUi.previousResult(panel)).toBeDisabled();
    await searchPageUi.nextResult(panel).click();
    await expect(panel).toContainText(secondText.slice(0, 30));

    // PDF에서 보기 opens that page of the PDF; Back returns to the same search and results.
    await searchUi.openInPdf(panel).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/workspaces/${ws.id}/documents/${enId}` && url.searchParams.has('page'),
    );
    const pdfPage = new URL(page.url()).searchParams.get('page');
    await expect(editorUi.currentPage(page)).toHaveValue(pdfPage ?? '');
    await page.goBack();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === searchPagePath(ws.id) &&
        url.searchParams.get('text') === 'water' &&
        url.searchParams.get('document') === enId,
    );
    await expect(searchPageUi.box(page)).toHaveValue('water');
    await expect(items.first()).toBeVisible();
    await expect(searchUi.excerptPanel(page)).toHaveCount(0);
  },
);

test.describe('SEARCH-02-AC02 touch', () => {
  const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 14'];
  test.use(iphone);

  test(
    'SEARCH-02-AC02 on a phone the excerpt opens as a modal bottom sheet',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const { owner, ws, enTitle } = await setupTwoBooks(workspaceFactory, 'search02-ac02-touch');

      await signInAs(page, owner.user);
      await page.goto(searchPagePath(ws.id));
      await expect(searchPageUi.heading(page)).toBeVisible();
      await searchInDocument(page, 'chlorine', enTitle);
      const hit = searchUi
        .resultItems(page)
        .filter({ hasText: /chlorine/i })
        .first();
      await expect(hit).toBeVisible();
      await searchUi.excerpt(hit).tap();
      const panel = searchUi.excerptPanel(page);
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute('aria-modal', 'true');
      await expect(panel).toContainText(block(EN, 'ch2-s2-p2').text.slice(0, 40));
      const viewport = page.viewportSize();
      await expect
        .poll(async () => {
          const box = await panel.boundingBox();
          return box && viewport ? Math.round(viewport.height - (box.y + box.height)) : null;
        })
        .toBe(0);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'no horizontal page scroll').toBeLessThanOrEqual(0);
    },
  );
});

test(
  'SEARCH-02-AC03 the home ?text= and scope=content addresses and the old /search?q= route redirect to the search page and run that search',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search02-ac03');
    const ws = await workspaceFactory.create(owner);
    const koId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const chapter = await outlineNodeId(owner, koId, section(book('book-ko'), 'ch1').title);

    await signInAs(page, owner.user);
    const cases: readonly (readonly [string, Record<string, string>])[] = [
      [
        homePath(ws.id, 'text=주의&mode=keyword&q=개요&panel=history'),
        { text: '주의', mode: 'keyword' },
      ],
      [homePath(ws.id, 'scope=content&q=주의'), { text: '주의' }],
      [`/workspaces/${ws.id}/search?q=주의&chapter=${chapter}`, { text: '주의', section: chapter }],
    ];
    for (const [from, params] of cases) {
      await page.goto('/workspaces');
      await page.goto(from);
      await expect(page).toHaveURL((url) => {
        const got = [...url.searchParams.entries()].sort().join('&');
        const want = Object.entries(params).sort().join('&');
        return url.pathname === searchPagePath(ws.id) && got === want;
      });
      await expect(searchPageUi.heading(page)).toBeVisible();
      await expect(searchPageUi.box(page)).toHaveValue('주의');
      await expect(searchUi.resultItems(page).first().or(searchUi.emptyState(page))).toBeVisible();
      // The redirect left no entry: Back goes to the page before it.
      await page.goBack();
      await expect(page).toHaveURL((url) => url.pathname === '/workspaces');
    }
  },
);

test(
  "SEARCH-02-AC04 without a published book the search is disabled with its reason; another user's search page and API are not found",
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('search02-ac04');
    const ws = await workspaceFactory.create(owner);
    await paperOnlyWorkspace(owner, ws.id);
    const stranger = await workspaceFactory.member('search02-ac04-stranger');
    const other = await workspaceFactory.create(stranger);
    await uploadReadyBook(stranger, other.id, 'book-en');

    await signInAs(page, owner.user);
    await page.goto(searchPagePath(ws.id));
    await expect(searchPageUi.heading(page)).toBeVisible();
    const submit = searchPageUi.submit(page);
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAccessibleDescription(NO_BODY);
    await expect(main(page).getByText(NO_BODY)).toBeVisible();
    await searchPageUi.box(page).fill('chlorine');
    await searchPageUi.box(page).press('Enter');
    await expect(searchUi.resultsRegion(page)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has('text')).toBe(false);

    // Another user's workspace: the same 404 as an unknown one; the API gives no document text.
    const res = await page.goto(searchPagePath(other.id, 'text=chlorine'));
    expect(res?.status()).toBe(404);
    await expect(notFoundHeading(page)).toBeVisible();
    await expect(main(page)).not.toContainText(/chlorine/i);
    const unknown = await owner.api.request('POST', `/workspaces/${RANDOM_ID}/search`, {
      query: 'chlorine',
      mode: 'keyword',
    });
    const foreign = await owner.api.request('POST', `/workspaces/${other.id}/search`, {
      query: 'chlorine',
      mode: 'keyword',
    });
    expect(foreign.status).toBe(404);
    expect((foreign.body as Problem).detail).toBe((unknown.body as Problem).detail);
    expect(foreign.text).not.toMatch(/chlorine|disinfect|water/i);
  },
);
