// Workspace home URL state (docs/screens/questions-overview.md "Workspace 홈 레이아웃", UX3c).
// The home `/workspaces/:id` carries, besides the heatmap filters (overview-filters.ts) and the
// open question (`?question=`):
//   ?panel=documents|history|share                          open floating dialogs (repeatable, in
//        |chapter-note|document-summary                      the order they were opened)
//        |inactive-questions                                 (보관·초안 문제, UX7-BANK-2)
//        |question-duplicates                                (중복 문제 정리, editors, UX7-DEDUP)
//        |mock-exams                                         (모의고사, every member, MOCK-01)
//        |question-create                                    the modal 문제 등록 editor (UX7-BANK;
//                                                            not stacked, see FLOATING_PANELS)
//   ?chapter=<id> (with panel=chapter-note)                  the chapter of the 정리 노트 panel
//                                                            (CHNOTE-01); see noteChapterOf
//   &document=<id> (with panel=document-summary)             the summary panel's document (DOCSUM-01;
//                                                            while that panel is open the key is
//                                                            the panel's, not the content search's)
//   &mock=new|<id> (with panel=mock-exams)                   the 모의고사 dialog's 만들기 / detail view
//                                                            (MOCK-01; see mockViewOf)
//   ?practice=new&source=bank | ?practice=<run id>&i=<n>     the range run panel (QVIEW-01,
//                                                            QuestionViewer sequence; keys in
//                                                            lib/questions/practice-runs.ts)
//   ?q=<text>                                               the 문제 search (heatmap, UX7-SEARCH)
//   ?text=<text>&mode=&document=&section=                    the 본문 search and its options
//                                                            (search/state.ts); the UX6 `scope`
//                                                            key is migrated by legacyScopeRedirect
// Pure helpers, plus the redirects of the pre-UX3c routes onto the home and of retired URL
// state (`scope`, UX7-SEARCH; `question-pdfs` → `documents`, UX7-DOCS; `generate` → `mock-exams`,
// QGEN-RM): homeRedirect.
import {
  RUN_MOCK_PARAM,
  RUN_PARAM,
  RUN_SOURCE_PARAM,
  withRunState,
  type RunUrlState,
} from '@/lib/questions/practice-runs';

export const HOME_PANELS = [
  'documents',
  'history',
  'share',
  'chapter-note',
  'document-summary',
  'question-create',
  'inactive-questions',
  'question-duplicates',
  'mock-exams',
] as const;
export type HomePanel = (typeof HOME_PANELS)[number];

/** UX7-BANK: `?panel=question-create` opens the modal 문제 등록 editor (QOV-01-AC12). */
export const QUESTION_CREATE_PANEL = 'question-create' satisfies HomePanel;

/** UX7-BANK-2: `?panel=inactive-questions` opens the 보관·초안 문제 dialog (QOV-01-AC15). */
export const INACTIVE_QUESTIONS_PANEL = 'inactive-questions' satisfies HomePanel;

/** UX7-DEDUP: `?panel=question-duplicates` opens the 중복 문제 정리 dialog (QOV-01-AC16). */
export const DUPLICATES_PANEL = 'question-duplicates' satisfies HomePanel;

/** MOCK-01: `?panel=mock-exams` opens the 모의고사 dialog (every member). */
export const MOCK_EXAMS_PANEL = 'mock-exams' satisfies HomePanel;

/** The non-modal side panels: they stack and move the home content aside (UX3b). */
export function isFloatingPanel(panel: HomePanel): boolean {
  return panel !== QUESTION_CREATE_PANEL;
}
export const PANEL_PARAM = 'panel';
/** The practice panel's question (overview-filters.ts QUESTION_PARAM). */
const QUESTION_PARAM = 'question';

/** The unified search's scope (UX6), retired by UX7-SEARCH: only read to migrate old URLs. */
export const LEGACY_SCOPE_PARAM = 'scope';

type RawParams = Readonly<Record<string, string | string[] | undefined>>;
type Params = RawParams | URLSearchParams;

function all(params: Params, key: string): string[] {
  if (params instanceof URLSearchParams) return params.getAll(key);
  const value = params[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function isHomePanel(value: unknown): value is HomePanel {
  return typeof value === 'string' && (HOME_PANELS as readonly string[]).includes(value);
}

/** Open dialogs in opening order (unknown values and duplicates dropped). */
export function parsePanels(params: Params): HomePanel[] {
  const out: HomePanel[] = [];
  for (const value of all(params, PANEL_PARAM)) {
    if (isHomePanel(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

/** `search` (with or without `?`) with `panel` opened (moved to the end = on top) or closed. */
export function withPanel(search: string, panel: HomePanel, open: boolean): string {
  const params = new URLSearchParams(search);
  const panels = parsePanels(params).filter((p) => p !== panel);
  if (open) panels.push(panel);
  params.delete(PANEL_PARAM);
  for (const p of panels) params.append(PANEL_PARAM, p);
  const query = params.toString();
  return query ? `?${query}` : '';
}

// --- 정리 노트 panel (CHNOTE-01) ----------------------------------------------------------------
// The panel's route is `?panel=chapter-note&chapter=<id>` (docs/screens/chapter-notes.md), and
// `chapter` is also the heatmap's chapter filter (overview-filters.ts). One parameter cannot hold
// both: while the note panel is open, `chapter` names the note's chapter and the heatmap is not
// filtered by chapter; choosing a chapter filter closes the note panel.

export const CHAPTER_NOTE_PANEL = 'chapter-note' satisfies HomePanel;
const CHAPTER_PARAM = 'chapter';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isChapterNoteOpen(params: Params): boolean {
  return parsePanels(params).includes(CHAPTER_NOTE_PANEL);
}

/**
 * The chapter of the open 정리 노트 panel: `undefined` when the panel is closed, `null` when it is
 * open without a usable chapter id (the panel then says the chapter cannot be found).
 */
export function noteChapterOf(params: Params): string | null | undefined {
  if (!isChapterNoteOpen(params)) return undefined;
  const id = all(params, CHAPTER_PARAM)[0];
  return id && UUID.test(id) ? id.toLowerCase() : null;
}

/** `search` with the 정리 노트 panel opened on `chapterId` (on top), or closed (`null`). */
export function withChapterNote(search: string, chapterId: string | null): string {
  const opened = withPanel(search, CHAPTER_NOTE_PANEL, chapterId !== null);
  return patchSearch(opened, { [CHAPTER_PARAM]: chapterId });
}

/**
 * Opening the 정리 노트 panel on `chapterId` from the current `search`: the new query, and whether
 * an already-open note panel (maybe under another dialog, on any chapter) must be raised — the
 * most recently requested panel is on top (UX3b stacking, chapter-notes.md "panel").
 */
export function openChapterNote(
  search: string,
  chapterId: string,
): { readonly search: string; readonly raise: boolean } {
  return {
    search: withChapterNote(search, chapterId),
    raise: isChapterNoteOpen(new URLSearchParams(search)),
  };
}

/**
 * The home query after a heatmap filter change: `merged` is `search` with the filters already
 * merged (overview-filters.ts mergeOverviewFilters), which rewrote `chapter`. A chapter filter
 * takes the parameter over and closes the note panel; any other change keeps the note's chapter.
 */
export function keepNoteChapter(
  search: string,
  merged: string,
  chapterFilter: string | null,
): string {
  const note = noteChapterOf(new URLSearchParams(search));
  if (note === undefined) return merged;
  if (chapterFilter !== null) return withPanel(merged, CHAPTER_NOTE_PANEL, false);
  return patchSearch(merged, { [CHAPTER_PARAM]: note });
}

// --- 문서 요약 panel (DOCSUM-01) ---------------------------------------------------------------

export const SUMMARY_PANEL = 'document-summary' satisfies HomePanel;
export const SUMMARY_DOCUMENT_PARAM = 'document';

/** The summary panel's document (DOCSUM-01) when that panel is open with a valid id, else null. */
export function summaryDocumentId(params: Params): string | null {
  if (!parsePanels(params).includes(SUMMARY_PANEL)) return null;
  const id = all(params, SUMMARY_DOCUMENT_PARAM)[0];
  return id !== undefined && UUID.test(id) ? id : null;
}

/** The content-search filter the summary panel borrowed the `document`/`section` keys from. */
export interface ContentDocumentFilter {
  readonly documentId: string | null;
  readonly chapterId: string | null;
}

/**
 * `search` with the summary panel opened on `documentId` (moved on top) or, for null, closed.
 * While the panel is open the `document` key is the panel's; closing it hands `document` and
 * `section` back to the content search: `restore` (the executed search's filter) or nothing.
 */
export function withSummaryPanel(
  search: string,
  documentId: string | null,
  restore: ContentDocumentFilter | null = null,
): string {
  const panels = withPanel(search, SUMMARY_PANEL, documentId !== null);
  if (documentId !== null) return patchSearch(panels, { [SUMMARY_DOCUMENT_PARAM]: documentId });
  const doc = restore?.documentId ?? null;
  return patchSearch(panels, {
    [SUMMARY_DOCUMENT_PARAM]: doc,
    section: doc ? (restore?.chapterId ?? null) : null,
  });
}

// --- 모의고사 dialog (MOCK-01) ------------------------------------------------------------------
// `?panel=mock-exams` is the list, `&mock=new` the 만들기 view and `&mock=<id>` a mock exam's
// detail. A mock exam's 풀기 opens the run panel on `?practice=new&source=mock&mock=<id>`: while
// that range step is open `mock` is the run's (practice-runs.ts), so the dialog keeps the view
// it showed (the home remembers it, workspace-home.tsx).

/** The 모의고사 dialog's view key (also the run panel's mock exam while it starts one). */
export const MOCK_PARAM = RUN_MOCK_PARAM;

export type MockView =
  | { readonly view: 'list' }
  | { readonly view: 'create' }
  | { readonly view: 'detail'; readonly mockExamId: string }
  /** `mock=` with a value that names no mock exam: "모의고사를 찾을 수 없습니다." */
  | { readonly view: 'missing' };

/** Whether `mock` belongs to the run panel's range step of a mock exam now. */
export function runOwnsMockParam(params: Params): boolean {
  return all(params, RUN_PARAM)[0] === 'new' && all(params, RUN_SOURCE_PARAM)[0] === 'mock';
}

/** The 모의고사 dialog's view in `params` (as the URL says; see runOwnsMockParam). */
export function mockViewOf(params: Params): MockView {
  const value = all(params, MOCK_PARAM)[0];
  if (!value) return { view: 'list' };
  if (value === 'new') return { view: 'create' };
  return UUID.test(value)
    ? { view: 'detail', mockExamId: value.toLowerCase() }
    : { view: 'missing' };
}

/** The `mock` value of a view (null: the list). */
export function mockParamOf(view: MockView): string | null {
  if (view.view === 'create') return 'new';
  if (view.view === 'detail') return view.mockExamId;
  return null;
}

/** `search` with the 모의고사 dialog open on `view` (on top). */
export function withMockView(search: string, view: MockView): string {
  return patchSearch(withPanel(search, MOCK_EXAMS_PANEL, true), {
    [MOCK_PARAM]: mockParamOf(view),
  });
}

/**
 * `search` with the 모의고사 dialog (when open there) back on `shown`, the view it showed while a
 * run's range step borrowed `mock` (runOwnsMockParam): what closing that step or moving the run
 * on hands back. Unchanged while the range step still owns `mock`.
 */
export function withShownMockView(search: string, shown: MockView): string {
  const params = new URLSearchParams(search);
  if (!parsePanels(params).includes(MOCK_EXAMS_PANEL) || runOwnsMockParam(params)) return search;
  return patchSearch(search, { [MOCK_PARAM]: mockParamOf(shown) });
}

/** `search` with the 모의고사 dialog closed: its view goes with it (not a run's mock exam). */
export function withoutMockExams(search: string): string {
  const closed = withPanel(search, MOCK_EXAMS_PANEL, false);
  return runOwnsMockParam(new URLSearchParams(search))
    ? closed
    : patchSearch(closed, { [MOCK_PARAM]: null });
}

/**
 * `search` with every dialog, the practice panel and the run panel closed (UX7-BACK: what the entry before the
 * first open gets when a dialog closes, panel-history.ts). The summary panel hands `document` and
 * `section` back to the content search (`restore`, see withSummaryPanel); the 정리 노트 panel
 * takes its `chapter` with it.
 */
export function withoutPanels(
  search: string,
  restore: ContentDocumentFilter | null = null,
): string {
  const panels = parsePanels(new URLSearchParams(search));
  let out = search;
  if (panels.includes(SUMMARY_PANEL)) out = withSummaryPanel(out, null, restore);
  if (panels.includes(CHAPTER_NOTE_PANEL)) out = withChapterNote(out, null);
  if (panels.includes(MOCK_EXAMS_PANEL)) out = withoutMockExams(out);
  out = withRunState(out, null);
  return patchSearch(out, { [PANEL_PARAM]: null, [QUESTION_PARAM]: null });
}

/** The practice panel's name among the open dialogs (openDialogs). */
export const PRACTICE_DIALOG = 'question';

/**
 * The range run panel's name among the open dialogs (QVIEW-01 `?practice=`). Its steps (range,
 * positions, results) and which run it shows are not part of it: changing them is not a close.
 */
export const RUN_DIALOG = 'practice';

/**
 * What is open in `search` (UX7-BACK-2, panel-history.ts): the dialogs in opening order, then
 * the practice panel (PRACTICE_DIALOG). Which question, document or chapter they show is not
 * part of it: changing that is not a close.
 */
export function openDialogs(search: string): string[] {
  const params = new URLSearchParams(search);
  const out: string[] = parsePanels(params);
  if (params.get(QUESTION_PARAM)) out.push(PRACTICE_DIALOG);
  if (params.get(RUN_PARAM)) out.push(RUN_DIALOG);
  return out;
}

// The practice panel and the range run panel are never open together (QVIEW-01-AC09, user
// decision 2026-11-02): both are modal, and opening one closes the other first.

/** `search` with the practice panel on `questionId` and the run panel closed. */
export function withPracticeQuestion(search: string, questionId: string): string {
  return patchSearch(withRunState(search, null), { [QUESTION_PARAM]: questionId });
}

/** `search` with the run panel on `state` and the practice panel closed. */
export function withRunPanel(search: string, state: RunUrlState): string {
  return withRunState(patchSearch(search, { [QUESTION_PARAM]: null }), state);
}

/** `search` with a mock exam's 풀기: the run panel's range step on it, the practice panel closed. */
export function withMockRun(search: string, mockExamId: string): string {
  return withRunPanel(search, { step: 'picker', source: 'mock', mockExamId });
}

/**
 * When going from `current` to `target` opens the practice panel or the run panel while the other
 * one is open: `current` with that other one closed (the open is then a close followed by an open,
 * panel-history.ts). Null when the move closes nothing.
 */
export function exclusiveClose(current: string, target: string): string | null {
  const now = openDialogs(current);
  const next = openDialogs(target);
  for (const [opens, closes] of [
    [RUN_DIALOG, PRACTICE_DIALOG],
    [PRACTICE_DIALOG, RUN_DIALOG],
  ] as const) {
    if (next.includes(opens) && !now.includes(opens) && now.includes(closes)) {
      return closeDialog(current, closes);
    }
  }
  return null;
}

/** `search` with one dialog of openDialogs closed, as its close button does it. */
export function closeDialog(
  search: string,
  dialog: string,
  restore: ContentDocumentFilter | null = null,
): string {
  if (dialog === PRACTICE_DIALOG) return patchSearch(search, { [QUESTION_PARAM]: null });
  if (dialog === RUN_DIALOG) return withRunState(search, null);
  if (dialog === SUMMARY_PANEL) return withSummaryPanel(search, null, restore);
  if (dialog === CHAPTER_NOTE_PANEL) return withChapterNote(search, null);
  if (dialog === MOCK_EXAMS_PANEL) return withoutMockExams(search);
  return isHomePanel(dialog) ? withPanel(search, dialog, false) : search;
}

/** Whether the summary panel owns the URL's `document`/`section` keys (it is open). */
export function summaryOwnsDocumentKey(params: Params): boolean {
  return parsePanels(params).includes(SUMMARY_PANEL);
}

/**
 * The address-bar params as the content search reads them. While the summary panel owns
 * `document`/`section`, they are replaced by the executed search's own filter (`executed`), so
 * opening, switching or closing the panel never changes what the content search runs on.
 */
export function contentSearchParams(
  params: URLSearchParams,
  executed: ContentDocumentFilter | null,
): URLSearchParams {
  if (!summaryOwnsDocumentKey(params)) return params;
  const out = new URLSearchParams(params);
  out.delete(SUMMARY_DOCUMENT_PARAM);
  out.delete('section');
  if (executed?.documentId) {
    out.set(SUMMARY_DOCUMENT_PARAM, executed.documentId);
    if (executed.chapterId) out.set('section', executed.chapterId);
  }
  return out;
}

/**
 * A content-search write of `next` (a full query string) onto `current`: while the summary panel
 * owns `document`/`section` in `current`, those keys keep `current`'s values whatever `next` says.
 */
export function keepSummaryDocument(current: string, next: string): string {
  const before = new URLSearchParams(current);
  if (!summaryOwnsDocumentKey(before)) return next;
  const after = new URLSearchParams(next);
  for (const key of [SUMMARY_DOCUMENT_PARAM, 'section']) {
    after.delete(key);
    for (const value of before.getAll(key)) after.append(key, value);
  }
  const query = after.toString();
  return query ? `?${query}` : '';
}

/**
 * The summary panel's document when it is one of `documents` (this workspace's list), else null:
 * an id from another workspace is never loaded on this home, even when the user can read it.
 */
export function ownSummaryDocument<T extends { readonly id: string }>(
  documentId: string | null,
  documents: readonly T[],
): T | null {
  if (!documentId) return null;
  return documents.find((d) => d.id === documentId) ?? null;
}

/** The summary panel of `documentId` on the workspace home (the DOC-02 header link). */
export function summaryPanelPath(workspaceId: string, documentId: string): string {
  return workspaceHomePath(
    workspaceId,
    `${PANEL_PARAM}=${SUMMARY_PANEL}&${SUMMARY_DOCUMENT_PARAM}=${encodeURIComponent(documentId)}`,
  );
}

/**
 * Params without the summary panel's `document` key (and the chapter filter tied to it), so the
 * content search never reads the panel's document as its own filter.
 */
export function withoutSummaryDocument<T extends RawParams | URLSearchParams>(params: T): T {
  if (!parsePanels(params).includes(SUMMARY_PANEL)) return params;
  if (params instanceof URLSearchParams) {
    const out = new URLSearchParams(params);
    out.delete(SUMMARY_DOCUMENT_PARAM);
    out.delete('section');
    return out as T;
  }
  const { [SUMMARY_DOCUMENT_PARAM]: _document, section: _section, ...rest } = params;
  return rest as T;
}

/**
 * `search` with the given keys replaced: `undefined` keeps a key, `null`/'' removes it, a string
 * sets it. Returns '' or a string starting with `?`.
 */
export function patchSearch(
  search: string,
  patch: Readonly<Record<string, string | null | undefined>>,
): string {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null || value === '') params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function workspaceHomePath(workspaceId: string, search = ''): string {
  const query = search.startsWith('?') || search === '' ? search : `?${search}`;
  return `/workspaces/${workspaceId}${query}`;
}

function toSearchParams(params: RawParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.append(key, v);
  }
  return out;
}

/** `/workspaces/:id/questions?…` (QOV-01 before UX3c): the same query on the home. */
export function legacyQuestionsRedirect(workspaceId: string, params: RawParams): string {
  return workspaceHomePath(workspaceId, toSearchParams(params).toString());
}

/**
 * `/workspaces/:id/search?q=&mode=&document=&chapter=` (SEARCH-01 before UX3c): the same 본문
 * search on the home, its query as `text` (UX7-SEARCH). Its chapter filter is a document section,
 * renamed `section` there (the home's `chapter` is the heatmap's question chapter). The old
 * `papers` flag is dropped: the 본문 search never covers question papers (UX7-SEARCH-2).
 */
export function legacySearchRedirect(workspaceId: string, params: RawParams): string {
  const source = toSearchParams(params);
  const out = new URLSearchParams();
  const query = source.get('q');
  if (query) out.set('text', query);
  for (const key of ['mode', 'document']) {
    const value = source.get(key);
    if (value) out.set(key, value);
  }
  const chapter = source.get('chapter');
  if (chapter && out.has('document')) out.set('section', chapter);
  return workspaceHomePath(workspaceId, out.toString());
}

/**
 * A home URL of the UX6 unified search (`scope=` present), migrated to the split searches
 * (UX7-SEARCH), or null when there is nothing to migrate. `scope=content` searched the body only:
 * its `q` becomes the 본문 `text`. Any other scope (`questions`, `none`) is dropped and `q` stays the
 * 문제 search. The old `papers` flag is dropped. Every other key is kept.
 */
export function legacyScopeRedirect(workspaceId: string, params: RawParams): string | null {
  const source = toSearchParams(params);
  if (!source.has(LEGACY_SCOPE_PARAM)) return null;
  const scope = source.get(LEGACY_SCOPE_PARAM);
  source.delete(LEGACY_SCOPE_PARAM);
  source.delete('papers');
  const query = source.get('q');
  if (scope === 'content') {
    source.delete('q');
    if (query && !source.has('text')) source.set('text', query);
  }
  return workspaceHomePath(workspaceId, source.toString());
}

/**
 * The retired 전체 문제 page (`/questions/bank`, UX7-BANK): the home. Only `?question=` carries
 * over (the home's practice panel); the bank's filters and `create` mean nothing there.
 */
export function legacyBankRedirect(workspaceId: string, params: RawParams): string {
  const question = all(params, 'question')[0];
  return workspaceHomePath(
    workspaceId,
    question && UUID.test(question) ? `question=${encodeURIComponent(question)}` : '',
  );
}

/**
 * Retired `?panel=` values and the dialog that replaced them: 문제 PDF 관리 was merged into
 * 문서 관리 (UX7-DOCS, DOC-01-AC09), and the 문제 생성 dialog of the retired 변형 출제 gave way to
 * 모의고사 (QGEN-RM, MOCK-01-AC01).
 */
const RETIRED_PANELS: Readonly<Record<string, HomePanel>> = {
  'question-pdfs': 'documents',
  generate: MOCK_EXAMS_PANEL,
};

/**
 * The home URL with every retired `?panel=` value replaced by its successor (in place; a panel
 * already open is not listed twice) and the rest of the query kept, or null when there is none.
 */
export function retiredPanelRedirect(workspaceId: string, params: RawParams): string | null {
  const source = toSearchParams(params);
  const values = source.getAll(PANEL_PARAM);
  if (!values.some((v) => Object.hasOwn(RETIRED_PANELS, v))) return null;
  const panels: string[] = [];
  for (const value of values) {
    const panel = Object.hasOwn(RETIRED_PANELS, value) ? RETIRED_PANELS[value] : value;
    if (panel !== undefined && !panels.includes(panel)) panels.push(panel);
  }
  const out = new URLSearchParams();
  for (const [key, value] of source) if (key !== PANEL_PARAM) out.append(key, value);
  for (const panel of panels) out.append(PANEL_PARAM, panel);
  return workspaceHomePath(workspaceId, out.toString());
}

/**
 * A link that opens both the practice panel and the run panel (QVIEW-01-AC09): the home URL
 * without `question`, so only the run opens (proposal: the run is the later intent). Null when
 * the URL does not carry both.
 */
export function exclusivePanelRedirect(workspaceId: string, params: RawParams): string | null {
  const source = toSearchParams(params);
  if (!source.get(QUESTION_PARAM) || !source.get(RUN_PARAM)) return null;
  source.delete(QUESTION_PARAM);
  return workspaceHomePath(workspaceId, source.toString());
}

/**
 * Every migration of retired or conflicting home URL state, applied together so a link takes a
 * single redirect: the UX6 search `scope` (legacyScopeRedirect, UX7-SEARCH), retired `?panel=`
 * values (retiredPanelRedirect, UX7-DOCS and QGEN-RM), then a practice panel beside a run
 * (exclusivePanelRedirect, QVIEW-01-AC09). Null when the URL is current.
 */
export function homeRedirect(workspaceId: string, params: RawParams): string | null {
  let current = params;
  let out: string | null = null;
  for (const step of [legacyScopeRedirect, retiredPanelRedirect, exclusivePanelRedirect]) {
    const next = step(workspaceId, current);
    if (next === null) continue;
    out = next;
    const parsed: Record<string, string[]> = {};
    for (const [key, value] of new URL(next, 'http://home').searchParams) {
      (parsed[key] ??= []).push(value);
    }
    current = parsed;
  }
  return out;
}

/**
 * The retired 변형 출제 review and batch pages (`/questions/generate?source=&run=` · `?batch=`,
 * QGEN-RM): the home with the 모의고사 dialog that replaced them; their query means nothing there.
 */
export function legacyGenerateRedirect(workspaceId: string): string {
  return legacyPanelRedirect(workspaceId, MOCK_EXAMS_PANEL);
}

/** A pre-UX3c section page (`/documents`, `/history`, `/settings/sharing`): its dialog. */
export function legacyPanelRedirect(workspaceId: string, panel: HomePanel): string {
  return workspaceHomePath(workspaceId, `${PANEL_PARAM}=${panel}`);
}
