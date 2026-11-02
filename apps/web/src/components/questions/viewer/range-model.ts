// Pure `QuestionRangePicker` model (QVIEW-01 "범위 고르기 단계", questions.md §12): the chapter groups
// of the questions a range can hold (the Heatmap's: CONFIRMED only, Heatmap order), the tri-state
// selection over the visible questions and the range a selection sends (`전체 선택` and whole
// chapters as `all` / `chapter_ids`, single questions as ids — QVIEW-01-C01). Unit-tested.
import type { QuestionDotStatus } from '@quiz/ui';
import { displayStem } from '@/lib/questions/display-stem';
import type { QuestionOverview } from '@/lib/questions/overview-data';
import { NO_CHAPTER_KEY, placeQuestions } from '@/lib/questions/overview-placement';
import type { RunRange, RunRangeFilters } from '@/lib/questions/practice-runs';
import type { QuestionType } from './question-body';

export interface RangeQuestion {
  readonly id: string;
  /** "1장 1번" (as the Heatmap numbers it). */
  readonly number: string;
  readonly preview: string;
  readonly type: QuestionType;
}

export interface RangeGroup {
  /** The chapter id, or `none` for the questions without a chapter. */
  readonly key: string;
  readonly title: string;
  readonly questions: readonly RangeQuestion[];
}

/** Characters of the stem shown in a question's row ("발문 앞 40자"). */
export const RANGE_STEM_CHARS = 40;

/** The overview's questions as range groups, in Heatmap order. */
export function rangeGroups(overview: Pick<QuestionOverview, 'chapters' | 'items'>): RangeGroup[] {
  const groups: { key: string; title: string; questions: RangeQuestion[] }[] = [];
  for (const placed of placeQuestions(overview.chapters, overview.items)) {
    let group = groups.find((g) => g.key === placed.chapterKey);
    if (!group) {
      group = { key: placed.chapterKey, title: placed.chapterTitle, questions: [] };
      groups.push(group);
    }
    const chapter =
      placed.chapterNumber !== undefined
        ? `${placed.chapterNumber}장 `
        : placed.chapterKey === NO_CHAPTER_KEY
          ? ''
          : `${placed.chapterTitle} `;
    group.questions.push({
      id: placed.item.question_id,
      number: `${chapter}${placed.number}번`,
      preview: displayStem(placed.item.preview).replace(/\s+/g, ' ').trim(),
      type: placed.item.question_type,
    });
  }
  return groups;
}

export type TriState = boolean | 'indeterminate';

/** Checked when every id is selected, indeterminate when some are, unchecked otherwise. */
export function triState(ids: readonly string[], selected: ReadonlySet<string>): TriState {
  let count = 0;
  for (const id of ids) if (selected.has(id)) count += 1;
  if (count === 0) return false;
  return count === ids.length ? true : 'indeterminate';
}

/** `selected` with `ids` all added (`on`) or all removed. */
export function setIds(
  selected: ReadonlySet<string>,
  ids: readonly string[],
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** A checkbox click: a checked group clears, an unchecked or mixed one selects all of it. */
export function toggleIds(selected: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  return setIds(selected, ids, triState(ids, selected) !== true);
}

export function allIds(groups: readonly RangeGroup[]): string[] {
  return groups.flatMap((g) => g.questions.map((q) => q.id));
}

/** The selection keeps only visible questions (a filter hid the others: they are dropped). */
export function keepVisible(
  selected: ReadonlySet<string>,
  groups: readonly RangeGroup[],
): Set<string> {
  const visible = new Set(allIds(groups));
  return new Set([...selected].filter((id) => visible.has(id)));
}

export interface RangeFilterState {
  readonly status: readonly QuestionDotStatus[];
  readonly favorite: boolean;
  readonly retry: boolean;
  readonly type: QuestionType | null;
}

export const EMPTY_RANGE_FILTERS: RangeFilterState = {
  status: [],
  favorite: false,
  retry: false,
  type: null,
};

export function isRangeFiltered(filters: RangeFilterState): boolean {
  return filters.status.length > 0 || filters.favorite || filters.retry || filters.type !== null;
}

/** The API's filters (the overview's judgement, QVIEW-01-C07); undefined when none is set. */
export function rangeApiFilters(filters: RangeFilterState): RunRangeFilters | undefined {
  if (!isRangeFiltered(filters)) return undefined;
  return {
    ...(filters.status.length > 0 ? { status: [...filters.status] } : {}),
    ...(filters.favorite ? { favorite: true } : {}),
    ...(filters.retry ? { retry: true } : {}),
    ...(filters.type ? { type: filters.type } : {}),
  };
}

/**
 * The range `시작` sends for `selected` among the visible `groups`: everything visible as `all`,
 * whole chapters as `chapter_ids`, the rest as `question_ids`, with the filters that made them
 * visible. Null when nothing is selected.
 */
export function rangeRequest(
  groups: readonly RangeGroup[],
  selected: ReadonlySet<string>,
  filters: RangeFilterState,
): RunRange | null {
  const visible = keepVisible(selected, groups);
  if (visible.size === 0) return null;
  const apiFilters = rangeApiFilters(filters);
  const withFilters = apiFilters ? { filters: apiFilters } : {};
  if (triState(allIds(groups), visible) === true) return { all: true, ...withFilters };
  const chapterIds: string[] = [];
  const questionIds: string[] = [];
  for (const group of groups) {
    const ids = group.questions.map((q) => q.id);
    const state = triState(ids, visible);
    if (state === true) chapterIds.push(group.key);
    else if (state === 'indeterminate') questionIds.push(...ids.filter((id) => visible.has(id)));
  }
  return {
    ...(chapterIds.length > 0 ? { chapter_ids: chapterIds } : {}),
    ...(questionIds.length > 0 ? { question_ids: questionIds } : {}),
    ...withFilters,
  };
}
