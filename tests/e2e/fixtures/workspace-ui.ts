// Role/label locators for WS-01, DOC-01, DOC-02 and SEARCH-01 (Korean first, English accepted;
// AGENTS.md §5). This is the UI contract M3.0 assumes for M3.1b/M3.3/M3.5/M3.6b; the specs only
// reach elements through these helpers so a deliberate label change is a one-line edit here.
//
//   WS-01      "Workspace 만들기" button (empty-state CTA when there is no active workspace,
//              otherwise in the header), create dialog with "Workspace 이름",
//              tabs "활성"/"보관됨", one list item per workspace (link = workspace name, role
//              badge "소유자"/"Owner"), per-item "더보기" menu: 공유 · 보관 · 삭제; delete asks for
//              confirmation in an alertdialog. Unknown/deleted/foreign workspace routes render the
//              app's not-found page with HTTP 404.
//   Home       (UX3c) `/workspaces/:id`: hidden h1 (workspace name), header with the unified
//              search (searchbox "검색어", icon button "검색", text button "검색 옵션" →
//              popover with checkboxes "문제"/"내용" and one list of options that follows
//              them), buttons "문서 n", "문제" (menu button, UX4: menuitems "PDF 관리",
//              "직접 추가", "변형 출제"; the last two for editors), "문제은행" (link), then
//              icon buttons "이력" and "공유하기" (owner); dialogs are non-modal
//              FloatingSidePanels inside <main> named "문서 관리", "문제 PDF 관리", "문제 생성",
//              "이력", "링크 공유" (`?panel=documents|question-pdfs|generate|history|share`).
//   DOC-01     "문서 관리" dialog: dashed Dropzone whose "PDF 업로드" button opens a file
//              chooser (the only upload button); one list item per book document with an
//              upload progressbar, processing status, "준비 완료"/"Ready"; "취소"/"다시 시도";
//              trash icon button "<title> 삭제".
//   DOC-02     outline tree "목차" (treeitems), PDF viewer region with a "현재 페이지" field and a
//              labelled source highlight, text editor region "원문" whose current block carries
//              aria-current="true"; block "편집"/"저장", revision status "초안"/"발행됨", "발행".
//   SEARCH-01  the home's unified search: searchbox "검색어"; in the "검색 옵션" popover (portalled
//              to <body>) radiogroup "검색 방식" (키워드/의미/하이브리드), comboboxes "문서"/"장";
//              region "원문 검색 결과" with list "검색 결과" whose items quote the source text in a
//              <blockquote>; excerpt in a non-modal FloatingSidePanel (role=dialog without
//              aria-modal) with "PDF에서 보기".
import { expect, type Locator, type Page } from '@playwright/test';
import { PROTECTED_LANDING, submitLogin } from './auth-ui.ts';

/** Signs `user` in through the real /login form in this (cookie-less) context. */
export async function signInAs(
  page: Page,
  user: { readonly email: string; readonly password: string },
): Promise<void> {
  await submitLogin(page, user);
  await expect(page).toHaveURL(PROTECTED_LANDING);
}

export const notFoundHeading = (page: Page): Locator =>
  page.getByRole('heading', { name: /찾을 수 없|not found/i });

/** The app's main landmark (AppShell owns it on protected routes). */
export const main = (page: Page): Locator => page.getByRole('main');

/** The workspace home (UX3c), optionally with a query (`panel=…`, `q=…`). */
export function homePath(workspaceId: string, query = ''): string {
  return `/workspaces/${workspaceId}${query ? `?${query}` : ''}`;
}

/** The home with the "문서 관리" dialog open (`/documents` redirects here). */
export function documentsPath(workspaceId: string): string {
  return homePath(workspaceId, 'panel=documents');
}

/** The home with the unified search limited to 원문 (`/search` redirects here). */
export function searchPath(workspaceId: string): string {
  return homePath(workspaceId, 'scope=content');
}

export const homeUi = {
  header: (page: Page) => main(page).getByRole('search', { name: /통합 검색|search/i }),
  documentsButton: (page: Page) =>
    main(page).getByRole('button', { name: /^(문서|documents)\s*\d+$/i }),
  bankLink: (page: Page) => main(page).getByRole('link', { name: /^(문제은행|question bank)$/i }),
  historyButton: (page: Page) => main(page).getByRole('button', { name: /^(이력|history)$/i }),
  shareButton: (page: Page) => main(page).getByRole('button', { name: /^(공유하기|share)$/i }),
  /** The header's `문제` menu button (UX4). Its menu is portalled to <body>. */
  questionMenuButton: (page: Page) =>
    main(page).getByRole('button', { name: /^(문제|questions)$/i }),
  questionMenu: (page: Page) => page.getByRole('menu', { name: /^(문제|questions)$/i }),
  questionMenuItem: (page: Page, item: QuestionMenuItem) =>
    homeUi.questionMenu(page).getByRole('menuitem', { name: QUESTION_MENU_ITEMS[item] }),
  dialog: (page: Page, name: RegExp) => main(page).getByRole('dialog', { name }),
  documentsDialog: (page: Page) => homeUi.dialog(page, /^(문서 관리|documents)$/i),
  questionPdfsDialog: (page: Page) => homeUi.dialog(page, /^(문제 pdf 관리|question pdfs?)$/i),
  generateDialog: (page: Page) => homeUi.dialog(page, /^(문제 생성|generate questions?)$/i),
  shareDialog: (page: Page) => homeUi.dialog(page, /^(링크 공유|share link)$/i),
  searchOptionsButton: (page: Page) =>
    main(page).getByRole('button', { name: /^(검색 옵션|search options)$/i }),
  searchOptions: (page: Page) =>
    page.getByRole('dialog', { name: /^(검색 옵션|search options)$/i }),
  scopeQuestions: (page: Page) =>
    homeUi.searchOptions(page).getByRole('checkbox', { name: /^(문제|questions)$/i }),
  scopeContent: (page: Page) =>
    homeUi.searchOptions(page).getByRole('checkbox', { name: /^(내용|content)$/i }),
  statusFilterToggle: (page: Page) =>
    main(page).getByRole('button', { name: /^(상태 필터|status filter)$/i }),
  statusFilters: (page: Page) =>
    main(page).getByRole('group', { name: /^(상태 필터|status filter)$/i }),
};

type QuestionMenuItem = 'pdfs' | 'create' | 'generate';
const QUESTION_MENU_ITEMS: Readonly<Record<QuestionMenuItem, RegExp>> = {
  pdfs: /^(pdf 관리|manage pdfs?)$/i,
  create: /^(직접 추가|add question)$/i,
  generate: /^(변형 출제|generate variants?)$/i,
};

/** Opens the header's `문제` menu and chooses `item` (UX4). */
export async function chooseQuestionMenu(page: Page, item: QuestionMenuItem): Promise<void> {
  await homeUi.questionMenuButton(page).click();
  await homeUi.questionMenuItem(page, item).click();
}

/** Opens the "검색 옵션" popover (no-op when it is open). */
export async function openSearchOptions(page: Page): Promise<Locator> {
  const button = homeUi.searchOptionsButton(page);
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  const popover = homeUi.searchOptions(page);
  await expect(popover).toBeVisible();
  return popover;
}

/** Closes the "검색 옵션" popover when it is open. */
export async function closeSearchOptions(page: Page): Promise<void> {
  if ((await homeUi.searchOptionsButton(page).getAttribute('aria-expanded')) !== 'true') return;
  await page.keyboard.press('Escape');
  await expect(homeUi.searchOptions(page)).toBeHidden();
}

export const wsUi = {
  createButton: (page: Page): Locator => wsUi.createButtons(page).first(),
  createButtons: (page: Page) =>
    main(page).getByRole('button', { name: /workspace (만들기|생성)|(create|new) workspace/i }),
  emptyState: (page: Page) =>
    main(page).getByRole('heading', { name: /workspace(가|이)? 없|no workspaces/i }),
  createDialog: (page: Page) =>
    page.getByRole('dialog', { name: /workspace (만들기|생성)|(create|new) workspace/i }),
  nameField: (scope: Locator) => scope.getByRole('textbox', { name: /이름|name/i }),
  submitCreate: (dialog: Locator) =>
    dialog.getByRole('button', { name: /^(만들기|생성|create)$/i }),
  // `\b` is ASCII-only in JS regexes and never matches next to Hangul; use a letter lookahead
  // (Unicode-aware) so "활성", "활성 (2)" and "Active" match but "활성화" does not.
  activeTab: (page: Page) => page.getByRole('tab', { name: /^(활성|active)(?!\p{L})/iu }),
  archivedTab: (page: Page) =>
    page.getByRole('tab', { name: /^(보관됨|보관|archived)(?!\p{L})/iu }),
  tabPanel: (page: Page) => page.getByRole('tabpanel'),
  item: (scope: Locator, name: string) =>
    scope
      .getByRole('listitem')
      .filter({ has: scope.page().getByRole('link', { name, exact: true }) }),
  ownerBadge: (item: Locator) => item.getByText(/^(소유자|owner)$/i),
  moreButton: (item: Locator) =>
    item.getByRole('button', { name: /더보기|작업|옵션|more|actions|options/i }),
  menuItem: (page: Page, name: RegExp) => page.getByRole('menuitem', { name }),
};

/** Opens the item's "더보기" menu and chooses `action` (공유 / 보관 / 삭제 …). */
export async function chooseWorkspaceAction(
  page: Page,
  item: Locator,
  action: RegExp,
): Promise<void> {
  await wsUi.moreButton(item).click();
  await wsUi.menuItem(page, action).click();
}

export const ARCHIVE_ACTION = /^(보관|보관하기|archive)$/i;
export const DELETE_ACTION = /^(삭제|삭제하기|delete)$/i;
export const SHARE_ACTION = /^(공유|공유 설정|share|sharing)/i;

export const docUi = {
  uploadButton: (page: Page): Locator => docUi.uploadButtons(page).first(),
  uploadButtons: (page: Page) =>
    main(page).getByRole('button', { name: /pdf 업로드|업로드|upload( pdf)?/i }),
  emptyState: (page: Page) => main(page).getByRole('heading', { name: /문서가 없|no documents/i }),
  /** A document row/list item, matched by its displayed title. */
  item: (page: Page, title: RegExp) =>
    main(page).getByRole('listitem').or(main(page).getByRole('row')).filter({ hasText: title }),
  uploadProgress: (scope: Locator) => scope.getByRole('progressbar', { name: /업로드|upload/i }),
  processing: (scope: Locator) =>
    scope
      .getByRole('progressbar', { name: /파싱|분석|색인|처리|parsing|indexing|processing/i })
      .or(
        scope.getByText(
          /대기 중|파싱 중|분석 중|색인 중|처리 중|queued|parsing|indexing|processing/i,
        ),
      ),
  ready: (scope: Locator) => scope.getByText(/준비 완료|사용 가능|^ready$/i),
  cancel: (scope: Locator) => scope.getByRole('button', { name: /^(업로드 )?(취소|cancel)/i }),
  retry: (scope: Locator) => scope.getByRole('button', { name: /다시 시도|재시도|retry/i }),
  alert: (page: Page) => main(page).getByRole('alert'),
};

export const editorUi = {
  outline: (page: Page) => page.getByRole('tree', { name: /목차|outline/i }),
  outlineItem: (page: Page, title: string) =>
    editorUi.outline(page).getByRole('treeitem', { name: title }),
  viewer: (page: Page) => page.getByRole('region', { name: /pdf/i }),
  currentPage: (page: Page) => editorUi.viewer(page).getByLabel(/현재 페이지|current page/i),
  highlight: (page: Page) =>
    editorUi.viewer(page).getByLabel(/원문 위치|출처 위치|source (location|highlight)/i),
  textPanel: (page: Page) => page.getByRole('region', { name: /원문|텍스트|canonical|text/i }),
  currentBlock: (page: Page) => editorUi.textPanel(page).locator('[aria-current="true"]'),
  /** The editable block containing `text`. */
  block: (page: Page, text: string) =>
    editorUi.textPanel(page).getByRole('article').filter({ hasText: text }),
  editButton: (block: Locator) => block.getByRole('button', { name: /^(편집|수정|edit)/i }),
  blockTextbox: (page: Page) =>
    editorUi.textPanel(page).getByRole('textbox', { name: /블록|원문|block|text/i }),
  saveButton: (page: Page) =>
    editorUi.textPanel(page).getByRole('button', { name: /^(저장|save)/i }),
  revisionStatus: (page: Page) => main(page).getByRole('status'),
  publishButton: (page: Page) => main(page).getByRole('button', { name: /^(발행|publish)/i }),
  retryIndexButton: (page: Page) =>
    main(page).getByRole('button', { name: /다시 (색인|시도)|재색인|retry/i }),
};

export const DRAFT_SAVED = /초안.*(저장|생성)|draft (saved|created)/i;
export const PUBLISHED = /발행(됨| 완료)|published/i;
export const INDEX_FAILED = /색인.*실패|indexing failed|reindex(ing)? failed/i;

export const searchUi = {
  box: (page: Page) => main(page).getByRole('searchbox', { name: /검색|search/i }),
  submit: (page: Page) => main(page).getByRole('button', { name: /^(검색|search)$/i }),
  /** Inside the "검색 옵션" popover (open it first: openSearchOptions). */
  modeGroup: (page: Page) =>
    page.getByRole('radiogroup', { name: /검색 (방식|모드)|search mode/i }),
  mode: (page: Page, mode: 'keyword' | 'semantic' | 'hybrid') =>
    searchUi.modeGroup(page).getByRole('radio', {
      name: {
        keyword: /키워드|keyword/i,
        semantic: /의미|semantic/i,
        hybrid: /하이브리드|hybrid/i,
      }[mode],
    }),
  documentFilter: (page: Page) => page.getByRole('combobox', { name: /^(문서|document)$/i }),
  /** The document-section filter (the heatmap's question filter is "챕터"). */
  chapterFilter: (page: Page) => page.getByRole('combobox', { name: /^(장|section)$/i }),
  resultsRegion: (page: Page) =>
    main(page).getByRole('region', { name: /원문 검색 결과|content results/i }),
  closeResults: (page: Page) =>
    main(page).getByRole('button', { name: /검색 결과 닫기|close results/i }),
  results: (page: Page) => main(page).getByRole('list', { name: /검색 결과|search results/i }),
  resultItems: (page: Page) => searchUi.results(page).getByRole('listitem'),
  /** The quoted source text of each result (the part whose language is the book's). */
  excerpt: (items: Locator) => items.getByRole('blockquote'),
  emptyState: (page: Page) =>
    main(page).getByRole('heading', { name: /검색 결과가 없|결과 없음|no results/i }),
  excerptPanel: (page: Page) => page.getByRole('dialog', { name: /발췌|원문|excerpt|source/i }),
  openInPdf: (panel: Locator) =>
    panel
      .getByRole('button', { name: /pdf에서 (보기|열기)|pdf 위치|open in pdf/i })
      .or(panel.getByRole('link', { name: /pdf에서 (보기|열기)|pdf 위치|open in pdf/i })),
};

/** "p. 4" / "4쪽" / "페이지 4" / "page 4" for page `n`. */
export function pageLabel(n: number): RegExp {
  // Digit lookarounds instead of `\b`, which is ASCII-only and fails next to Hangul ("4쪽에서").
  return new RegExp(
    `(p\\.\\s*${n}(?!\\d)|(?<!\\d)${n}\\s*쪽|페이지\\s*${n}(?!\\d)|page\\s*${n}(?!\\d))`,
    'i',
  );
}

/** Runs a search through the UI: mode first (search options), then query + Enter. */
export async function runSearch(
  page: Page,
  query: string,
  mode: 'keyword' | 'semantic' | 'hybrid',
): Promise<void> {
  await openSearchOptions(page);
  await searchUi.mode(page, mode).check();
  await closeSearchOptions(page);
  await searchUi.box(page).fill(query);
  await searchUi.box(page).press('Enter');
}

/** Picks `option` in a filter combobox (Radix Select / listbox popup). */
export async function chooseFilter(page: Page, combobox: Locator, option: RegExp): Promise<void> {
  await combobox.click();
  await page.getByRole('option', { name: option }).click();
}
