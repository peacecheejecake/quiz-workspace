// Workspace home URL state (docs/screens/questions-overview.md "Workspace 홈 레이아웃", UX3c).
// The home `/workspaces/:id` carries, besides the heatmap filters (overview-filters.ts) and the
// open question (`?question=`):
//   ?panel=documents|question-pdfs|generate|history|share   open floating dialogs (repeatable, in
//        |chapter-note|document-summary                      the order they were opened)
//   ?chapter=<id> (with panel=chapter-note)                  the chapter of the 정리 노트 panel
//                                                            (CHNOTE-01); see noteChapterOf
//   &document=<id> (with panel=document-summary)             the summary panel's document (DOCSUM-01;
//                                                            while that panel is open the key is
//                                                            the panel's, not the content search's)
//   ?q=<text>&scope=questions|content|none                    unified search (no scope = both;
//                                                            none = both boxes off, UX6)
//   ?mode=&document=&section=&papers=1                        content-search options (state.ts)
// Pure helpers, plus the redirects of the pre-UX3c routes onto the home.

export const HOME_PANELS = [
  'documents',
  'question-pdfs',
  'generate',
  'history',
  'share',
  'chapter-note',
  'document-summary',
] as const;
export type HomePanel = (typeof HOME_PANELS)[number];
export const PANEL_PARAM = 'panel';

export type SearchScope = 'all' | 'questions' | 'content' | 'none';
export const SCOPE_PARAM = 'scope';

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

/**
 * `search` with the summary panel opened on `documentId` (moved on top) or, for null, closed
 * (its `document` key goes with it).
 */
export function withSummaryPanel(search: string, documentId: string | null): string {
  const panels = withPanel(search, SUMMARY_PANEL, documentId !== null);
  return patchSearch(panels, { [SUMMARY_DOCUMENT_PARAM]: documentId });
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

export function parseScope(params: Params): SearchScope {
  const value = all(params, SCOPE_PARAM)[0];
  return value === 'questions' || value === 'content' || value === 'none' ? value : 'all';
}

export function scopeIncludesQuestions(scope: SearchScope): boolean {
  return scope === 'all' || scope === 'questions';
}

export function scopeIncludesContent(scope: SearchScope): boolean {
  return scope === 'all' || scope === 'content';
}

/** The scope for the "문제"/"본문" checkboxes (both may be off, UX6). */
export function scopeOf(questions: boolean, content: boolean): SearchScope {
  if (questions && content) return 'all';
  if (questions) return 'questions';
  if (content) return 'content';
  return 'none';
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
 * `/workspaces/:id/search?q=&mode=&document=&chapter=&papers=1` (SEARCH-01 before UX3c): the same
 * content search on the home. Its chapter filter is a document section, renamed `section` there
 * (the home's `chapter` is the heatmap's question chapter).
 */
export function legacySearchRedirect(workspaceId: string, params: RawParams): string {
  const source = toSearchParams(params);
  const out = new URLSearchParams();
  for (const key of ['q', 'mode', 'document', 'papers']) {
    const value = source.get(key);
    if (value) out.set(key, value);
  }
  const chapter = source.get('chapter');
  if (chapter && out.has('document')) out.set('section', chapter);
  out.set(SCOPE_PARAM, 'content');
  return workspaceHomePath(workspaceId, out.toString());
}

/** A pre-UX3c section page (`/documents`, `/history`, `/settings/sharing`): its dialog. */
export function legacyPanelRedirect(workspaceId: string, panel: HomePanel): string {
  return workspaceHomePath(workspaceId, `${PANEL_PARAM}=${panel}`);
}
