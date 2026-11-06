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
//              "중복 문제 정리", aria-disabled without edit rights with the reason as menu text,
//              then "보관·초안 문제" · "모의고사" · "문제 풀기" for every member; no "전체 문제"
//              since UX7-BANK, no "PDF 관리" since UX7-DOCS, no "변형 출제" since QGEN-RM), then
//              icon buttons "이력" and "공유하기" (owner); dialogs are non-modal
//              FloatingSidePanels inside <main> named "문서 관리", "모의고사", "이력", "링크 공유"
//              (`?panel=documents|mock-exams|history|share`; the retired 문제 PDF 관리
//              `?panel=question-pdfs` redirects to `documents`, UX7-DOCS, and the retired 문제 생성
//              `?panel=generate` to `mock-exams`, QGEN-RM).
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
//              labelled source highlight, text editor region "변환본 텍스트" (DOCVIEW-01; any
//              name with 원문/텍스트) whose current block carries aria-current="true"; block
//              "편집"/"저장", revision status "초안"/"발행됨", "발행". The layout around them
//              (settings bar, outline panel, splitter) is in fixtures/document-viewer.ts.
//   UX12-FILTER  under the sticky line: icon button "검색" ("검색 닫기" once open) that opens the
//              문제 search box, and icon button "필터" → popover "필터" (combobox "챕터" = tree popover
//              UX12-PICKER, combobox "유형" = Select).
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
 * The 본문 search page, where the 본문 search lives since UX9 (SEARCH-02; before, a collapsed area
 * of the home). The home's `?text=` and the old `/search?q=` redirect here.
 */
export function searchPath(workspaceId: string): string {
  return `/workspaces/${workspaceId}/search`;
}

/** The home's one menu (UX12-HEADER): named `문서 N` like its button (Radix labels it so). */
export const HOME_MENU_NAME = /^(문서|documents)\s*\d+$/i;

export const homeUi = {
  /** The header's 문제 search (UX7-SEARCH; the unified search before). */
  header: (page: Page) =>
    main(page).getByRole('search', { name: /^(문제 검색|question search|search questions)$/i }),
  /**
   * The sticky line's `문서 N` menu button. It opens the menu, not the 문서 관리 dialog: use
   * `openDocuments` for that. The name stays for what the old button was used for: its count, its
   * place and focus coming back to it.
   */
  documentsButton: (page: Page) => main(page).getByRole('button', { name: HOME_MENU_NAME }),
  historyButton: (page: Page) => main(page).getByRole('button', { name: /^(이력|history)$/i }),
  shareButton: (page: Page) => main(page).getByRole('button', { name: /^(공유하기|share)$/i }),
  /** The same `문서 N` button, for the `문제` items that moved into its menu (UX12-HEADER). */
  questionMenuButton: (page: Page) => homeUi.documentsButton(page),
  /** The `문서 N` menu, portalled to <body>: open it with `openMenu`. */
  questionMenu: (page: Page) => page.getByRole('menu', { name: HOME_MENU_NAME }),
  openMenu: (page: Page, press: MenuPress = 'click') => openHomeMenu(page, press),
  /** Opens the 문서 관리 dialog through the `문서 N` menu (UX12-HEADER). */
  openDocuments: (page: Page, press: MenuPress = 'click') =>
    chooseQuestionMenu(page, 'documents', press),
  questionMenuItem: (page: Page, item: QuestionMenuItem) =>
    homeUi.questionMenu(page).getByRole('menuitem', { name: QUESTION_MENU_ITEMS[item] }),
  dialog: (page: Page, name: RegExp) => main(page).getByRole('dialog', { name }),
  documentsDialog: (page: Page) => homeUi.dialog(page, /^(문서 관리|documents)$/i),
  /** The retired 문제 PDF 관리 dialog (UX7-DOCS): only ever expected to be absent. */
  questionPdfsDialog: (page: Page) => homeUi.dialog(page, /^(문제 pdf 관리|question pdfs?)$/i),
  /** The retired 문제 생성 dialog (QGEN-RM): only ever expected to be absent. */
  generateDialog: (page: Page) => homeUi.dialog(page, /^(문제 생성|generate questions?)$/i),
  shareDialog: (page: Page) => homeUi.dialog(page, /^(링크 공유|share link)$/i),
  /**
   * The 문제 search box: filters the heatmap as you type (SEARCH-01-AC12). Closed by default
   * (UX12-FILTER): `openQuestionSearch` first, unless the URL has `q`.
   */
  questionSearch: (page: Page) =>
    homeUi.header(page).getByRole('searchbox', {
      name: /^(문제 검색|question search|search questions)$/i,
    }),
  /** The button that opens the box; named 검색 닫기 while it is open (UX12-FILTER). */
  questionSearchButton: (page: Page) =>
    homeUi.header(page).getByRole('button', { name: /^(검색|search|검색 닫기|close search)$/i }),
  /** The status message under the 문제 search (why it is disabled). */
  questionSearchMessage: (page: Page) => homeUi.header(page).getByRole('status'),
  /** The home's retired "본문 검색" disclosure button (SEARCH-01-AC10, retired by UX9). */
  contentSearchToggle: (page: Page) =>
    main(page).getByRole('button', { name: /^(본문 검색|body search|content search)$/i }),
  /** The 본문 search page's link in the `문서 N` menu (SEARCH-02, UX12-HEADER): open the menu first. */
  contentSearchLink: (page: Page) => homeUi.questionMenuItem(page, 'contentSearch'),
  /** The 본문 search form (on the 본문 search page since UX9). */
  contentSearch: (page: Page) =>
    main(page).getByRole('search', { name: /^(본문 검색|body search|content search)$/i }),
  /** The status message of the 본문 search (why its button is disabled). */
  contentSearchMessage: (page: Page) => homeUi.contentSearch(page).getByRole('status'),
  /** The button of a search's settings popover: 필터 on the home, "본문 설정" for the 본문 search. */
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
  questions: /^(필터|filters?)$/i,
  body: /^(본문 설정|body settings|content settings)$/i,
};
const SCOPE_SETTINGS: Readonly<Record<SearchScopeName, RegExp>> = {
  questions: /^(필터|filters?)$/i,
  body: /^(본문 검색 설정|body search settings|content search settings)$/i,
};

type QuestionMenuItem =
  | 'pdfs'
  | 'create'
  | 'generate'
  | 'duplicates'
  | 'documents'
  | 'contentSearch'
  | 'redistribution'
  | 'inactive'
  | 'mockExams'
  | 'practice'
  | 'ask';
const QUESTION_MENU_ITEMS: Readonly<Record<QuestionMenuItem, RegExp>> = {
  /** UX12-HEADER: every member, like 본문 검색 below. */
  documents: /^(문서 관리|documents)$/i,
  contentSearch: /^(본문 검색|body search|content search)$/i,
  /** Retired by UX7-DOCS: only ever expected to be absent. */
  pdfs: /^(pdf 관리|manage pdfs?)$/i,
  create: /^(직접 추가|add question)$/i,
  /** Retired by QGEN-RM (MOCK-01-AC01): only ever expected to be absent. */
  generate: /^(변형 출제|generate variants?)$/i,
  /** UX7-DEDUP: the 중복 문제 정리 dialog, editors only (QOV-01-AC16). */
  duplicates: /^(중복 문제 정리|clean up duplicates|duplicate questions)$/i,
  /** CHREDIST-01 (UX9-REDIST-W): the 챕터 재분배 dialog, editors only. */
  redistribution: /^(챕터 재분배|redistribute chapters)$/i,
  /** UX7-BANK-2: the 보관·초안 문제 dialog, usable by every member. */
  inactive: /^(보관·초안 문제|archived and draft questions)$/i,
  /** MOCK-01: the 모의고사 dialog, usable by every member. */
  mockExams: /^(모의고사|mock exams?)$/i,
  /** QVIEW-01: the range run (QuestionViewer sequence), usable by every member. */
  practice: /^(문제 풀기|practice questions?|start practice)$/i,
  /** ASK-01: the AI 질문 panel, last; usable by every member (disabled when archived or off). */
  ask: /^(AI 질문|ask ai)$/i,
};

/**
 * The `문제` menu's editor-only items (UX7-DOCS-2, UX7-DEDUP, CHREDIST-01; 변형 출제 retired by
 * QGEN-RM).
 */
const EDITOR_ITEMS = ['create', 'duplicates', 'redistribution'] as const;

/** Every `문서 N` menu item in order (UX12-HEADER). */
export const QUESTION_MENU_ORDER = [
  QUESTION_MENU_ITEMS.documents,
  QUESTION_MENU_ITEMS.contentSearch,
  QUESTION_MENU_ITEMS.create,
  QUESTION_MENU_ITEMS.duplicates,
  QUESTION_MENU_ITEMS.redistribution,
  QUESTION_MENU_ITEMS.inactive,
] as const;

/** Why the `문제` menu's editor-only items are disabled (UX7-DOCS-2, QOV-01-AC11). */
export const QUESTION_MENU_REASONS = {
  viewer: /^(편집 권한이 있어야 사용할 수 있습니다|you need edit rights to use these)\.?$/i,
  archived: /^(보관된 workspace는 읽기 전용입니다|archived workspaces are read-only)\.?$/i,
} as const;

/**
 * Without edit rights the `문제` button stays (UX7-DOCS-2, QOV-01-AC11): its menu shows 직접 추가
 * and 중복 문제 정리 aria-disabled (보관·초안 문제 · 모의고사 · 문제 풀기 enabled, UX7-BANK-2,
 * MOCK-SYNC), has no 변형 출제 (QGEN-RM), says why in text (described-by), skips them with the
 * arrow keys and opens nothing when one is clicked. Leaves the menu closed, focus back on the button.
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
  await expect(menu.getByRole('menuitem')).toHaveText([...QUESTION_MENU_ORDER]);
  // UX7-BANK-2: 보관·초안 문제 is readable by everyone, so it stays enabled; so are 모의고사
  // (MOCK-01, listing and practising mock exams) and 문제 풀기 (QVIEW-01, a personal practice run).
  for (const item of ['documents', 'contentSearch', 'inactive'] as const) {
    await expect(homeUi.questionMenuItem(page, item)).not.toHaveAttribute('aria-disabled', 'true');
  }
  await expect(homeUi.questionMenuItem(page, 'pdfs')).toHaveCount(0);
  await expect(homeUi.questionMenuItem(page, 'generate')).toHaveCount(0);
  const text = QUESTION_MENU_REASONS[reason];
  await expect(menu.getByText(text)).toBeVisible();
  for (const item of EDITOR_ITEMS) {
    const el = homeUi.questionMenuItem(page, item);
    await expect(el).toHaveAttribute('aria-disabled', 'true');
    await expect(el).toHaveAccessibleDescription(text);
  }
  await expect(menu).toHaveAccessibleDescription(text);
  // The arrow keys skip the disabled items (문서 관리 → 본문 검색 → 보관·초안 문제); Escape returns to
  // the button.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(homeUi.questionMenuItem(page, 'inactive')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();
  // A click on a disabled item opens nothing.
  const before = new URL(page.url()).searchParams.getAll('panel');
  for (const item of EDITOR_ITEMS) {
    await button.click();
    const el = homeUi.questionMenuItem(page, item);
    // Radix positions the menu after measuring: wait until it is placed before clicking.
    await expect(el).toBeInViewport();
    await el.click({ force: true });
    await expect(
      page.getByRole('dialog', { name: /^(중복 문제 정리|duplicate questions)$/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('dialog', { name: /^(챕터 재분배|redistribute chapters)$/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('dialog', { name: /문제 (등록|추가)|(new|add) question/i }),
    ).toHaveCount(0);
    expect(new URL(page.url()).searchParams.getAll('panel')).toEqual(before);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  }
}

type MenuPress = 'click' | 'tap';

/** Opens the `문서 N` menu; a press lost to a page still hydrating is pressed again. */
async function openHomeMenu(page: Page, press: MenuPress): Promise<void> {
  const menu = homeUi.questionMenu(page);
  await expect(async () => {
    if (!(await menu.isVisible())) await homeUi.questionMenuButton(page)[press]();
    await expect(menu).toBeVisible({ timeout: 2_000 });
  }).toPass();
}

/** Opens the header's `문서 N` menu and chooses `item` (UX12-HEADER). */
export async function chooseQuestionMenu(
  page: Page,
  item: QuestionMenuItem,
  press: MenuPress = 'click',
): Promise<void> {
  if (item === 'mockExams') {
    const url = new URL(page.url());
    url.searchParams.append('panel', 'mock-exams');
    await page.goto(url.toString());
    return;
  }
  await openHomeMenu(page, press);
  await homeUi.questionMenuItem(page, item)[press]();
}

/**
 * Makes the 본문 search form available: on the home, follows the `문서 N` menu's `본문 검색` link to
 * the search page (SEARCH-02, UX12-HEADER); on the search page, a no-op.
 */
export async function openContentSearch(page: Page): Promise<void> {
  const box = searchUi.box(page);
  const button = homeUi.questionMenuButton(page);
  await expect(box.or(button).first()).toBeVisible();
  if (!(await box.isVisible())) await chooseQuestionMenu(page, 'contentSearch');
  await expect(box).toBeVisible();
}

/** Opens the home's 문제 search (UX12-FILTER; no-op when it is open) and returns the box. */
export async function openQuestionSearch(page: Page): Promise<Locator> {
  const button = homeUi.questionSearchButton(page);
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  const box = homeUi.questionSearch(page);
  await expect(box).toBeFocused();
  return box;
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
  currentPage: (page: Page) => page.getByLabel(/현재 페이지|current page/i),
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
  /** The 본문 search box (on the 본문 search page: openContentSearch). */
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
    main(page).getByRole('button', {
      name: /검색 결과 (지우기|닫기)|clear results|close results/i,
    }),
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

/**
 * The chapter tree popover (UX12-PICKER): combobox trigger with `aria-haspopup="dialog"`, popover
 * dialog named by the label, searchbox "챕터 찾기"/"장 찾기", tree of treeitems (`aria-label` = the
 * title) with buttons "<제목> 펼치기"/"<제목> 접기". Portalled to <body>; only in the DOM while open.
 */
export const chapterPickerUi = {
  rows: (page: Page) => page.getByRole('tree').getByRole('treeitem'),
  row: (page: Page, name: RegExp | string) =>
    page
      .getByRole('tree')
      .getByRole('treeitem', typeof name === 'string' ? { name, exact: true } : { name }),
  filter: (page: Page) =>
    page.getByRole('searchbox', { name: /^((챕터|장) 찾기|find (chapter|section))$/i }),
  expand: (page: Page, title: string) =>
    page.getByRole('tree').getByRole('button', { name: `${title} 펼치기`, exact: true }),
  collapse: (page: Page, title: string) =>
    page.getByRole('tree').getByRole('button', { name: `${title} 접기`, exact: true }),
};

/** Opens every collapsed row of the open chapter tree. */
async function expandChapterTree(page: Page): Promise<void> {
  await page.getByRole('tree').waitFor();
  const next = page
    .getByRole('tree')
    .getByRole('button', { name: /펼치기$/ })
    .first();
  while ((await next.count()) > 0) await next.click();
}

/**
 * Picks `option` in a filter combobox: a Radix Select / listbox popup, or the chapter tree popover
 * (UX12-PICKER), which it expands first so that sub-chapters are reachable.
 */
export async function chooseFilter(page: Page, combobox: Locator, option: RegExp): Promise<void> {
  // Read first: an open Select hides the combobox from the accessibility tree.
  const tree = (await combobox.getAttribute('aria-haspopup')) === 'dialog';
  await combobox.click();
  if (tree) {
    await expandChapterTree(page);
    await chapterPickerUi.row(page, option).click();
    return;
  }
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
