// QOV-01 heatmap filters as URL query state (docs/questions.md §7), using the overview API's own
// parameter names so the URL and the API query mirror each other:
//   ?chapter=<id>|none &type=MCQ|SHORT_ANSWER|ESSAY &q=<text> &status=<s>(repeatable)
//   &favorite=true|false &retry=true|false
// `question=<id>` (the open practice panel, QPLAY-01) lives in the same URL but is not a filter.
// Pure parse/serialize; unknown or malformed values fall back to "no filter".
import { QUESTION_DOT_STATUSES, type QuestionDotStatus, type QuestionType } from '@quiz/ui';

export interface OverviewFilters {
  /** A chapter id, `'none'` (questions without a chapter) or null (all chapters). */
  readonly chapter: string | null;
  readonly type: QuestionType | null;
  readonly q: string;
  /** Statuses to keep, in legend order; empty = every status. */
  readonly status: readonly QuestionDotStatus[];
  readonly favorite: boolean | null;
  readonly retry: boolean | null;
}

export const EMPTY_OVERVIEW_FILTERS: OverviewFilters = {
  chapter: null,
  type: null,
  q: '',
  status: [],
  favorite: null,
  retry: null,
};

export const OVERVIEW_SEARCH_MAX = 200;
export const QUESTION_PARAM = 'question';
export const NO_CHAPTER = 'none';

const TYPES = new Set<string>(['MCQ', 'SHORT_ANSWER', 'ESSAY']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = Readonly<Record<string, string | string[] | undefined>> | URLSearchParams;

function all(params: Params, key: string): string[] {
  if (params instanceof URLSearchParams) return params.getAll(key);
  const value = params[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function first(params: Params, key: string): string | undefined {
  return all(params, key)[0];
}

function bool(value: string | undefined): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function parseOverviewFilters(params: Params): OverviewFilters {
  const chapter = first(params, 'chapter');
  const type = first(params, 'type');
  const wanted = new Set(all(params, 'status'));
  return {
    chapter:
      chapter === NO_CHAPTER
        ? NO_CHAPTER
        : chapter && isUuid(chapter)
          ? chapter.toLowerCase()
          : null,
    type: type && TYPES.has(type) ? (type as QuestionType) : null,
    q: (first(params, 'q') ?? '').trim().slice(0, OVERVIEW_SEARCH_MAX),
    // Legend order, duplicates dropped: one canonical URL per filter set.
    status: QUESTION_DOT_STATUSES.filter((s) => wanted.has(s)),
    favorite: bool(first(params, 'favorite')),
    retry: bool(first(params, 'retry')),
  };
}

/** URLSearchParams for `filters` (defaults omitted), in a stable order. */
export function overviewFilterParams(filters: OverviewFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.chapter) params.set('chapter', filters.chapter);
  if (filters.type) params.set('type', filters.type);
  if (filters.q) params.set('q', filters.q);
  for (const s of filters.status) params.append('status', s);
  if (filters.favorite !== null) params.set('favorite', String(filters.favorite));
  if (filters.retry !== null) params.set('retry', String(filters.retry));
  return params;
}

/**
 * The overview URL query for `filters`, keeping the open question (`?question=`) when given.
 * Returns '' when nothing is set, else a string starting with `?`.
 */
export function overviewSearch(filters: OverviewFilters, questionId?: string | null): string {
  const params = overviewFilterParams(filters);
  if (questionId) params.set(QUESTION_PARAM, questionId);
  const query = params.toString();
  return query ? `?${query}` : '';
}

const SCOPE_KEYS = ['chapter', 'type', 'status', 'favorite', 'retry'] as const;

/**
 * `search` (the workspace home's address-bar query) with the heatmap's scope/state filters
 * replaced by `filters`'; `q` (owned by the unified search) and every other key are kept.
 * Returns '' or a string starting with `?`.
 */
export function mergeOverviewFilters(search: string, filters: OverviewFilters): string {
  const params = new URLSearchParams(search);
  for (const key of SCOPE_KEYS) params.delete(key);
  for (const [key, value] of overviewFilterParams({ ...filters, q: '' })) params.append(key, value);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** The open question of the practice panel (`?question=<uuid>`), or null. */
export function openQuestionId(params: Params): string | null {
  const id = first(params, QUESTION_PARAM);
  return id && isUuid(id) ? id.toLowerCase() : null;
}

/** Any filter set (scope or state). */
export function isOverviewFiltered(filters: OverviewFilters): boolean {
  return overviewFilterParams(filters).size > 0;
}

/** Overview API query (`GET /workspaces/{id}/questions/overview`) for `filters`. */
export function overviewApiQuery(filters: OverviewFilters): {
  chapter?: string;
  type?: QuestionType;
  q?: string;
  status?: QuestionDotStatus[];
  favorite?: boolean;
  retry?: boolean;
} {
  return {
    ...(filters.chapter ? { chapter: filters.chapter } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.status.length > 0 ? { status: [...filters.status] } : {}),
    ...(filters.favorite !== null ? { favorite: filters.favorite } : {}),
    ...(filters.retry !== null ? { retry: filters.retry } : {}),
  };
}
