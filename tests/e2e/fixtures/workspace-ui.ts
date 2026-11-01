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
//              search (searchbox "검색어", icon button "검색", under it checkboxes "문제"/"본문"
//              each followed by a "설정" text button named "문제 설정"/"본문 설정" → popover
//              "문제 검색 설정"/"본문 검색 설정", and a status message, UX6), buttons "문서 n", "문제" (menu button, UX4; shown to everyone, UX7-DOCS-2: menuitems
//              "직접 추가" (the modal "문제 등록" dialog, `?panel=question-create`, UX7-BANK) and
//              "변형 출제", aria-disabled without edit rights with the reason as menu text;
//              no "전체 문제" since UX7-BANK, no "PDF 관리" since UX7-DOCS), then
//              icon buttons "이력" and "공유하기" (owner); dialogs are non-modal
//              FloatingSidePanels inside <main> named "문서 관리", "문제 생성", "이력", "링크 공유"
//              (`?panel=documents|generate|history|share`; the retired 문제 PDF 관리
//              `?panel=question-pdfs` redirects to `documents`, UX7-DOCS).
//   DOC-01     "문서 관리" dialog: dashed Dropzone whose "PDF 업로드" button opens a file
//              chooser (the only upload button); one list item per book document with an
//              upload progressbar, processing status, "준비 완료"/"Ready"; "취소"/"다시 시도";
//              while uploading/processing an ordered list "진행 단계" 업로드 → 분석 → 색인 whose
//              items say 완료 / 진행 중 (aria-current="step") / 대기 (UX6-PROGRESS);
//              trash icon button "<title> 삭제". UX6-UPLOAD: every PDF (one upload place,
//              several files at once, no type choice); each row's kind badge text "교재" /
//              "문제지" / "교재+문제" ("분석 중" until classified) before the status badge; editors
//              get a "<title> 종류 변경" menu button (Radix menu, menuitemradio items, the
//              current one aria-checked) on ready rows and a refusal as an alert in the row;
//              question rows link "<title> 문제 검토" or offer the button "<title> 문제 추출".
//   DOC-02     outline tree "목차" (treeitems), PDF viewer region with a "현재 페이지" field and a
//              labelled source highlight, text editor region "원문" whose current block carries
//              aria-current="true"; block "편집"/"저장", revision status "초안"/"발행됨", "발행".
//   SEARCH-01  the home's unified search: searchbox "검색어"; in the "본문 검색 설정" popover
//              (portalled to <body>) radiogroup "검색 방식" (키워드/의미/하이브리드), comboboxes
//              "문서"/"장"; in "문제 검색 설정" comboboxes "챕터"/"유형"; region "본문 검색 결과" with list "검색 결과" whose items quote the source text in a
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

/**
 * The home, where the 본문 search lives (UX7-SEARCH: collapsed until its "본문 검색" disclosure is
 * opened; runSearch/openContentSearch open it). `/search?q=` redirects here with `text=`.
 */
export function searchPath(workspaceId: string): string {
  return homePath(workspaceId);
}

export const homeUi = {
  /** The header's 문제 search (UX7-SEARCH; the unified search before). */
  header: (page: Page) =>
    main(page).getByRole('search', { name: /^(문제 검색|question search|search questions)$/i }),
  documentsButton: (page: Page) =>
    main(page).getByRole('button', { name: /^(문서|documents)\s*\d+$/i }),
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
  /** The retired 문제 PDF 관리 dialog (UX7-DOCS): only ever expected to be absent. */
  questionPdfsDialog: (page: Page) => homeUi.dialog(page, /^(문제 pdf 관리|question pdfs?)$/i),
  generateDialog: (page: Page) => homeUi.dialog(page, /^(문제 생성|generate questions?)$/i),
  shareDialog: (page: Page) => homeUi.dialog(page, /^(링크 공유|share link)$/i),
  /** The 문제 search box: filters the heatmap as you type (SEARCH-01-AC12, no button). */
  questionSearch: (page: Page) =>
    homeUi.header(page).getByRole('searchbox', {
      name: /^(문제 검색|question search|search questions)$/i,
    }),
  /** The status message under the 문제 search (why it is disabled). */
  questionSearchMessage: (page: Page) => homeUi.header(page).getByRole('status'),
  /** The "본문 검색" disclosure button (collapsed by default, SEARCH-01-AC10). */
  contentSearchToggle: (page: Page) =>
    main(page).getByRole('button', { name: /^(본문 검색|body search|content search)$/i }),
  /** The 본문 search form inside the disclosure. */
  contentSearch: (page: Page) =>
    main(page).getByRole('search', { name: /^(본문 검색|body search|content search)$/i }),
  /** The status message of the 본문 search (why its button is disabled). */
  contentSearchMessage: (page: Page) => homeUi.contentSearch(page).getByRole('status'),
  /** The "설정" text button of a search; it opens that search's settings popover. */
  searchSettingsButton: (page: Page, scope: SearchScopeName) =>
    main(page).getByRole('button', { name: SCOPE_SETTINGS_BUTTONS[scope] }),
  searchSettings: (page: Page, scope: SearchScopeName) =>
    page.getByRole('dialog', { name: SCOPE_SETTINGS[scope] }),
  statusFilterToggle: (page: Page) =>
    main(page).getByRole('button', { name: /^(상태 필터|status filter)$/i }),
  statusFilters: (page: Page) =>
    main(page).getByRole('group', { name: /^(상태 필터|status filter)$/i }),
};

export type SearchScopeName = 'questions' | 'body';
const SCOPE_SETTINGS_BUTTONS: Readonly<Record<SearchScopeName, RegExp>> = {
  questions: /^(문제 설정|question settings)$/i,
  body: /^(본문 설정|body settings|content settings)$/i,
};
const SCOPE_SETTINGS: Readonly<Record<SearchScopeName, RegExp>> = {
  questions: /^(문제 검색 설정|question search settings)$/i,
  body: /^(본문 검색 설정|body search settings|content search settings)$/i,
};

type QuestionMenuItem = 'pdfs' | 'create' | 'generate' | 'inactive';
const QUESTION_MENU_ITEMS: Readonly<Record<QuestionMenuItem, RegExp>> = {
  /** Retired by UX7-DOCS: only ever expected to be absent. */
  pdfs: /^(pdf 관리|manage pdfs?)$/i,
  create: /^(직접 추가|add question)$/i,
  generate: /^(변형 출제|generate variants?)$/i,
  /** UX7-BANK-2: the 보관·초안 문제 dialog, usable by every member. */
  inactive: /^(보관·초안 문제|archived and draft questions)$/i,
};

/** Why the `문제` menu's editor-only items are disabled (UX7-DOCS-2, QOV-01-AC11). */
export const QUESTION_MENU_REASONS = {
  viewer: /^(편집 권한이 있어야 사용할 수 있습니다|you need edit rights to use these)\.?$/i,
  archived: /^(보관된 workspace는 읽기 전용입니다|archived workspaces are read-only)\.?$/i,
} as const;

/**
 * Without edit rights the `문제` button stays (UX7-DOCS-2, QOV-01-AC11): its menu shows 직접 추가
 * and 변형 출제 aria-disabled (보관·초안 문제 enabled, UX7-BANK-2), says why in text (described-by), skips them with the arrow keys
 * and opens nothing when one is clicked. Leaves the menu closed, focus back on the button.
 */
export async function expectReadOnlyQuestionMenu(
  page: Page,
  reason: keyof typeof QUESTION_MENU_REASONS,
): Promise<void> {
  const button = homeUi.questionMenuButton(page);
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('aria-haspopup', 'menu');
  await button.focus();
  await page.keyboard.press('Enter');
  const menu = homeUi.questionMenu(page);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText([
    QUESTION_MENU_ITEMS.create,
    QUESTION_MENU_ITEMS.generate,
    QUESTION_MENU_ITEMS.inactive,
  ]);
  // UX7-BANK-2: 보관·초안 문제 is readable by everyone, so it stays enabled.
  await expect(homeUi.questionMenuItem(page, 'inactive')).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(homeUi.questionMenuItem(page, 'pdfs')).toHaveCount(0);
  const text = QUESTION_MENU_REASONS[reason];
  await expect(menu.getByText(text)).toBeVisible();
  for (const item of ['create', 'generate'] as const) {
    const el = homeUi.questionMenuItem(page, item);
    await expect(el).toHaveAttribute('aria-disabled', 'true');
    await expect(el).toHaveAccessibleDescription(text);
  }
  await expect(menu).toHaveAccessibleDescription(text);
  // The arrow keys skip the disabled items (landing on 보관·초안 문제); Escape returns to the button.
  await page.keyboard.press('ArrowDown');
  for (const item of ['create', 'generate'] as const) {
    await expect(homeUi.questionMenuItem(page, item)).not.toBeFocused();
  }
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();
  // A click on a disabled item opens nothing.
  const before = new URL(page.url()).searchParams.getAll('panel');
  for (const item of ['create', 'generate'] as const) {
    await button.click();
    const el = homeUi.questionMenuItem(page, item);
    // Radix positions the menu after measuring: wait until it is placed before clicking.
    await expect(el).toBeInViewport();
    await el.click({ force: true });
    await expect(homeUi.generateDialog(page)).toHaveCount(0);
    await expect(
      page.getByRole('dialog', { name: /문제 (등록|추가)|(new|add) question/i }),
    ).toHaveCount(0);
    expect(new URL(page.url()).searchParams.getAll('panel')).toEqual(before);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  }
}

/** Opens the header's `문제` menu and chooses `item` (UX4). */
export async function chooseQuestionMenu(page: Page, item: QuestionMenuItem): Promise<void> {
  await homeUi.questionMenuButton(page).click();
  await homeUi.questionMenuItem(page, item).click();
}

/** Expands the collapsed 본문 search (SEARCH-01-AC10; no-op when it is open). */
export async function openContentSearch(page: Page): Promise<void> {
  const toggle = homeUi.contentSearchToggle(page);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(searchUi.box(page)).toBeVisible();
}

/** Opens a search's settings popover ("본문 설정" by default; no-op when it is open). */
export async function openSearchOptions(
  page: Page,
  scope: SearchScopeName = 'body',
): Promise<Locator> {
  if (scope === 'body') await openContentSearch(page);
  const button = homeUi.searchSettingsButton(page, scope);
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  const popover = homeUi.searchSettings(page, scope);
  await expect(popover).toBeVisible();
  return popover;
}

/** Closes a scope's settings popover when it is open. */
export async function closeSearchOptions(
  page: Page,
  scope: SearchScopeName = 'body',
): Promise<void> {
  const button = homeUi.searchSettingsButton(page, scope);
  if ((await button.getAttribute('aria-expanded')) !== 'true') return;
  const popover = homeUi.searchSettings(page, scope);
  // Escape closes the innermost layer first: a search-mode description tooltip (shown on hover or
  // keyboard focus) takes one press before the popover does.
  await expect(async () => {
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden({ timeout: 1_000 });
  }).toPass();
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
  /** UX6-UPLOAD: the row's kind badge, matched by its exact text. */
  kindBadge: (row: Locator, label: '교재' | '문제지' | '교재+문제' | '분석 중') =>
    row.getByText(label, { exact: true }),
  kindMenuButton: (row: Locator) => row.getByRole('button', { name: /종류 변경|change kind/i }),
  /** The open `종류 변경` menu (portalled to <body>). */
  kindMenu: (page: Page) => page.getByRole('menu', { name: /종류 변경|change kind/i }),
  kindOption: (page: Page, label: '교재' | '문제지' | '교재+문제') =>
    docUi.kindMenu(page).getByRole('menuitemradio', { name: label, exact: true }),
  reviewLink: (row: Locator) => row.getByRole('link', { name: /문제 검토|review questions/i }),
  extractButton: (row: Locator) =>
    row.getByRole('button', { name: /문제 추출|extract questions/i }),
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
  /** DOCVIEW (AC06): the `목차` toggle in the PDF toolbar and the floating outline panel. */
  outlineToggle: (page: Page) =>
    editorUi.viewer(page).getByRole('button', { name: /^(목차|outline)$/i }),
  outlinePanel: (page: Page) => page.getByRole('dialog', { name: /^(목차|outline)$/i }),
  /** The scrolling page area of the PDF viewer (continuous pages, AC07/AC08). */
  pdfPages: (page: Page) =>
    editorUi.viewer(page).getByRole('group', { name: /pdf 페이지 영역|pdf pages/i }),
  /** The rendered canvas of PDF page `n`. */
  pdfPage: (page: Page, n: number) =>
    editorUi
      .viewer(page)
      .getByRole('img', { name: new RegExp(`^(PDF ${n}쪽|PDF page ${n})$`, 'i') }),
  /** AC09: the text pane's group of blocks that start on page `n`, and its heading. */
  pageGroup: (page: Page, n: number) =>
    editorUi.textPanel(page).getByRole('group', { name: new RegExp(`^(${n}쪽|page ${n})$`, 'i') }),
  pageHeading: (page: Page, n: number) =>
    editorUi
      .textPanel(page)
      .getByRole('heading', { name: new RegExp(`^(${n}쪽|page ${n})$`, 'i') }),
  /** AC10: the PDF ↔ text width separator. */
  splitter: (page: Page) => page.getByRole('separator', { name: /(pdf|원문).*(폭|너비)|resize/i }),
  /** AC11: an imported, confirmed question shown in question format. */
  questionCard: (page: Page, n: number) =>
    editorUi
      .textPanel(page)
      .getByRole('group', { name: new RegExp(`^(${n}번 문제|question ${n})(\\D|$)`, 'i') }),
  answerToggle: (card: Locator) =>
    card.getByRole('button', { name: /정답.*(보기|확인)|show answer/i }),
  sourceBlocksToggle: (card: Locator) =>
    card.getByRole('button', { name: /원문 블록|source blocks/i }),
  revisionStatus: (page: Page) => main(page).getByRole('status'),
  publishButton: (page: Page) => main(page).getByRole('button', { name: /^(발행|publish)/i }),
  retryIndexButton: (page: Page) =>
    main(page).getByRole('button', { name: /다시 (색인|시도)|재색인|retry/i }),
};

export const DRAFT_SAVED = /초안.*(저장|생성)|draft (saved|created)/i;
export const PUBLISHED = /발행(됨| 완료)|published/i;
export const INDEX_FAILED = /색인.*실패|indexing failed|reindex(ing)? failed/i;

export const searchUi = {
  /** The 본문 search box (inside the "본문 검색" disclosure: openContentSearch). */
  box: (page: Page) =>
    main(page).getByRole('searchbox', { name: /^(본문 검색어|body search (query|text))$/i }),
  submit: (page: Page) => main(page).getByRole('button', { name: /^(검색|search)$/i }),
  /** Inside the "본문 검색 설정" popover (open it first: openSearchOptions). */
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
    main(page).getByRole('region', { name: /본문 검색 결과|content results/i }),
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

/** Runs a 본문 search through the UI: mode first ("본문 설정", which opens the 본문 search), then query + Enter. */
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

/**
 * The step list of a multi-step job (UX6-PROGRESS `StepProgress`): ordered list "진행 단계" with
 * one item per step. A step's state is text, not colour: 완료 / 진행 중 (aria-current="step") / 대기.
 */
export const progressStepsUi = {
  list: (scope: Locator) => scope.getByRole('list', { name: /^(진행 단계|progress steps)$/i }),
  step: (scope: Locator, name: RegExp) =>
    progressStepsUi.list(scope).getByRole('listitem').filter({ hasText: name }),
};

/** Asserts each step's state in order: `done`, `current` or `pending`. */
export async function expectProgressSteps(
  scope: Locator,
  steps: readonly (readonly [RegExp, 'done' | 'current' | 'pending'])[],
): Promise<void> {
  const items = progressStepsUi.list(scope).getByRole('listitem');
  await expect(items).toHaveCount(steps.length);
  for (const [index, [name, state]] of steps.entries()) {
    const item = items.nth(index);
    await expect(item).toContainText(name);
    if (state === 'current') {
      await expect(item).toHaveAttribute('aria-current', 'step');
      await expect(item).toContainText(/진행 중|in progress/i);
    } else {
      await expect(item).not.toHaveAttribute('aria-current', /.+/);
      await expect(item).toContainText(state === 'done' ? /완료|done/i : /대기|pending/i);
    }
  }
}
