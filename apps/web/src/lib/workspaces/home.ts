// Workspace home URL state (docs/screens/questions-overview.md "Workspace 홈 레이아웃", UX3c).
// The home `/workspaces/:id` carries, besides the heatmap filters (overview-filters.ts) and the
// open question (`?question=`):
//   ?panel=documents|question-pdfs|generate|history|share   open floating dialogs (repeatable, in
//                                                            the order they were opened)
//   ?q=<text>&scope=questions|content|none                    unified search (no scope = both;
//                                                            none = both boxes off, UX6)
//   ?mode=&document=&section=&papers=1                        content-search options (state.ts)
// Pure helpers, plus the redirects of the pre-UX3c routes onto the home.

export const HOME_PANELS = ['documents', 'question-pdfs', 'generate', 'history', 'share'] as const;
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
