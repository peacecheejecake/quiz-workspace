// QSEARCH-CACHE (docs/screens/search.md, SEARCH-01-AC12, QOV-01): client-side in-memory cache of
// Heatmap `QuestionOverview` snapshots and abortable BFF reader for live filter/search changes.
// Scoped to `(workspaceId, viewerId)`, bounded by TTL and entry count, never persisted to browser
// storage, and copied field by field so only documented answer-free `QuestionOverview` fields enter
// memory. Keyed by canonical `overviewSearch(filters)` (`""` = unfiltered full list).
import type { QuestionOverview } from './overview-data';
import {
  overviewFilterParams,
  overviewSearch,
  parseOverviewFilters,
  type OverviewFilters,
} from './overview-filters';
import { classifyQuestionFailure, type QuestionFailureKind } from './problems';

export const OVERVIEW_CACHE_TTL_MS = 5 * 60_000;
export const OVERVIEW_CACHE_MAX_ENTRIES = 50;

interface Entry {
  readonly overview: QuestionOverview;
  readonly storedAt: number;
}

export interface OverviewCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

/** Canonical cache key for `filters` or a search string (`""` = unfiltered). */
export function overviewCacheKey(filtersOrSearch: OverviewFilters | string): string {
  if (typeof filtersOrSearch === 'string') {
    const raw = filtersOrSearch.startsWith('?') ? filtersOrSearch.slice(1) : filtersOrSearch;
    return overviewSearch(parseOverviewFilters(new URLSearchParams(raw)));
  }
  return overviewSearch(filtersOrSearch);
}

/** The documented answer-free fields of `overview`, copied one by one (never a spread). */
export function answerFreeOverview(overview: QuestionOverview): QuestionOverview {
  return {
    counts: {
      total: overview.counts.total,
      unseen: overview.counts.unseen,
      viewed: overview.counts.viewed,
      incorrect: overview.counts.incorrect,
      correct: overview.counts.correct,
      retry: overview.counts.retry,
      favorite: overview.counts.favorite,
    },
    chapters: overview.chapters.map((chapter) => ({
      id: chapter.id,
      number: chapter.number,
      title: chapter.title,
      document_id: chapter.document_id,
      question_count: chapter.question_count,
    })),
    items: overview.items.map((item) => ({
      question_id: item.question_id,
      chapter_id: item.chapter_id,
      question_number: item.question_number,
      question_type: item.question_type,
      status: item.status,
      is_favorite: item.is_favorite,
      needs_retry: item.needs_retry,
      last_graded_result: item.last_graded_result,
      is_pending_grading: item.is_pending_grading,
      preview: item.preview,
    })),
  };
}

export class OverviewCache {
  readonly workspaceId: string;
  readonly viewerId: string | null;
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(workspaceId: string, viewerId: string | null, options: OverviewCacheOptions = {}) {
    this.workspaceId = workspaceId.toLowerCase();
    this.viewerId = viewerId ? viewerId.toLowerCase() : null;
    this.ttlMs = options.ttlMs ?? OVERVIEW_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? OVERVIEW_CACHE_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  matches(workspaceId: string, viewerId: string | null): boolean {
    const normalizedViewer = viewerId ? viewerId.toLowerCase() : null;
    return this.workspaceId === workspaceId.toLowerCase() && this.viewerId === normalizedViewer;
  }

  get(filtersOrSearch: OverviewFilters | string): QuestionOverview | null {
    const key = overviewCacheKey(filtersOrSearch);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() - entry.storedAt >= this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    // Refresh LRU order on hit so active queries stay warm (especially `""`).
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.overview;
  }

  put(filtersOrSearch: OverviewFilters | string, overview: QuestionOverview): void {
    const key = overviewCacheKey(filtersOrSearch);
    this.entries.delete(key);
    this.entries.set(key, { overview: answerFreeOverview(overview), storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export type OverviewFetchResult =
  | { readonly ok: true; readonly data: QuestionOverview }
  | { readonly ok: false; readonly aborted: true }
  | { readonly ok: false; readonly aborted: false; readonly kind: QuestionFailureKind };

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}

function isOverviewShape(value: unknown): value is QuestionOverview {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<QuestionOverview>;
  return (
    typeof candidate.counts === 'object' &&
    candidate.counts !== null &&
    Array.isArray(candidate.chapters) &&
    Array.isArray(candidate.items)
  );
}

export function overviewBffUrl(workspaceId: string, filters: OverviewFilters): string {
  const query = overviewFilterParams(filters).toString();
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/questions/overview${query ? `?${query}` : ''}`;
}

/** Reads `QuestionOverview` for `filters` through the same-origin BFF relay. */
export async function fetchQuestionOverview(
  workspaceId: string,
  filters: OverviewFilters,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<OverviewFetchResult> {
  let response: Response;
  try {
    response = await fetchImpl(overviewBffUrl(workspaceId, filters), {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal,
    });
  } catch (error) {
    if (isAbort(error, signal)) return { ok: false, aborted: true };
    return { ok: false, aborted: false, kind: 'unavailable' };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isAbort(error, signal)) return { ok: false, aborted: true };
    if (response.ok) return { ok: false, aborted: false, kind: 'unavailable' };
    body = undefined;
  }
  if (signal?.aborted) return { ok: false, aborted: true };
  if (!response.ok) {
    return {
      ok: false,
      aborted: false,
      kind: classifyQuestionFailure(response.status, body).kind,
    };
  }
  if (!isOverviewShape(body)) {
    return { ok: false, aborted: false, kind: 'unavailable' };
  }
  return { ok: true, data: answerFreeOverview(body) };
}
