// QBANK-01 list filters as URL query state (`?q=&type=&chapter=&status=`), shareable and restored
// on reload (docs/questions.md §7). Pure parse/serialize; unknown values fall back to defaults.
import type { PublicationStatus, QuestionType } from './form';

export type StatusFilter = PublicationStatus | 'ALL';

export interface BankFilters {
  readonly q: string;
  readonly type: QuestionType | null;
  readonly chapter: string | null;
  /** Bank default: CONFIRMED only (the API's default too). */
  readonly status: StatusFilter;
}

export const DEFAULT_FILTERS: BankFilters = {
  q: '',
  type: null,
  chapter: null,
  status: 'CONFIRMED',
};

export const SEARCH_MAX = 200;

const TYPES = new Set<string>(['MCQ', 'SHORT_ANSWER', 'ESSAY']);
const STATUSES = new Set<string>(['CONFIRMED', 'DRAFT', 'ARCHIVED', 'ALL']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = Readonly<Record<string, string | string[] | undefined>> | URLSearchParams;

function first(params: Params, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

export function parseBankFilters(params: Params): BankFilters {
  const q = (first(params, 'q') ?? '').trim().slice(0, SEARCH_MAX);
  const type = first(params, 'type');
  const chapter = first(params, 'chapter');
  const status = first(params, 'status');
  return {
    q,
    type: type && TYPES.has(type) ? (type as QuestionType) : null,
    chapter: chapter && UUID.test(chapter) ? chapter.toLowerCase() : null,
    status: status && STATUSES.has(status) ? (status as StatusFilter) : 'CONFIRMED',
  };
}

/** Query string for `filters` (defaults omitted); '' when every filter is at its default. */
export function serializeBankFilters(filters: BankFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.type) params.set('type', filters.type);
  if (filters.chapter) params.set('chapter', filters.chapter);
  if (filters.status !== 'CONFIRMED') params.set('status', filters.status);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function isFiltered(filters: BankFilters): boolean {
  return serializeBankFilters(filters) !== '';
}

/** `publication_status` query values for the list API. */
export function statusQuery(status: StatusFilter): PublicationStatus[] {
  return status === 'ALL' ? ['CONFIRMED', 'DRAFT', 'ARCHIVED'] : [status];
}
