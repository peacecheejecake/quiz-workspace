// Workspace home URL state (docs/screens/questions-overview.md "Workspace 홈 레이아웃", UX3c).
// The home `/workspaces/:id` carries, besides the heatmap filters (overview-filters.ts) and the
// open question (`?question=`):
//   ?panel=documents|generate|history|share                 open floating dialogs (repeatable, in
//        |chapter-note|document-summary                      the order they were opened)
//        |question-create                                    the modal 문제 등록 editor (UX7-BANK;
//                                                            not stacked, see FLOATING_PANELS)
//   ?chapter=<id> (with panel=chapter-note)                  the chapter of the 정리 노트 panel
//                                                            (CHNOTE-01); see noteChapterOf
//   &document=<id> (with panel=document-summary)             the summary panel's document (DOCSUM-01;
//                                                            while that panel is open the key is
//                                                            the panel's, not the content search's)
//   ?q=<text>                                               the 문제 search (heatmap, UX7-SEARCH)
//   ?text=<text>&mode=&document=&section=                    the 본문 search and its options
//                                                            (search/state.ts); the UX6 `scope`
//                                                            key is migrated by legacyScopeRedirect
// Pure helpers, plus the redirects of the pre-UX3c routes onto the home and of retired URL
// state (`scope`, UX7-SEARCH; `question-pdfs` → `documents`, UX7-DOCS): homeRedirect.

export const HOME_PANELS = [
  'documents',
  'generate',
  'history',
  'share',
  'chapter-note',
  'document-summary',
  'question-create',
] as const;
export type HomePanel = (typeof HOME_PANELS)[number];

/** UX7-BANK: `?panel=question-create` opens the modal 문제 등록 editor (QOV-01-AC12). */
export const QUESTION_CREATE_PANEL = 'question-create' satisfies HomePanel;

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

/**
 * `search` with every dialog and the practice panel closed (UX7-BACK: what the entry before the
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
  return patchSearch(out, { [PANEL_PARAM]: null, [QUESTION_PARAM]: null });
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
 * `papers` flag is dropped: question papers are always searched now.
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
 * 문서 관리 (UX7-DOCS, DOC-01-AC09).
 */
const RETIRED_PANELS: Readonly<Record<string, HomePanel>> = { 'question-pdfs': 'documents' };

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
 * Every migration of retired home URL state, applied together so an old link takes a single
 * redirect: the UX6 search `scope` (legacyScopeRedirect, UX7-SEARCH), then retired `?panel=`
 * values (retiredPanelRedirect, UX7-DOCS). Null when the URL is current.
 */
export function homeRedirect(workspaceId: string, params: RawParams): string | null {
  const scoped = legacyScopeRedirect(workspaceId, params);
  if (scoped === null) return retiredPanelRedirect(workspaceId, params);
  const next: Record<string, string[]> = {};
  for (const [key, value] of new URL(scoped, 'http://home').searchParams) {
    (next[key] ??= []).push(value);
  }
  return retiredPanelRedirect(workspaceId, next) ?? scoped;
}

/** A pre-UX3c section page (`/documents`, `/history`, `/settings/sharing`): its dialog. */
export function legacyPanelRedirect(workspaceId: string, panel: HomePanel): string {
  return workspaceHomePath(workspaceId, `${PANEL_PARAM}=${panel}`);
}
