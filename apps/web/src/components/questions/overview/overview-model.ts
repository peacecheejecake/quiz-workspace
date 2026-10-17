// Pure QOV-01 view model: overview API response → heatmap chapters, optimistic study-state
// overrides, and the practice panel's title. Unit-tested without a browser.
import { deriveDotStatus, type HeatmapChapter, type QuestionDotStatus } from '@quiz/ui';
import type { OverviewItem } from '@/lib/questions/overview-data';
import type { PlacedQuestion } from '@/lib/questions/overview-placement';

export {
  chapterKey,
  findPlaced,
  NO_CHAPTER_KEY,
  placedTitle,
  placeQuestions,
  type PlacedQuestion,
} from '@/lib/questions/overview-placement';

export type StudyPatch = Partial<
  Pick<OverviewItem, 'status' | 'is_favorite' | 'needs_retry' | 'last_graded_result'>
>;

/**
 * A local change to one question's study state, shown until the server's overview catches up:
 * `settledOn` is the server item list current when the mutation finished; once a newer list
 * arrives (revalidation), the server is the truth again and the override is ignored.
 */
export interface StudyOverride {
  readonly patch: StudyPatch;
  readonly settledOn: readonly OverviewItem[] | null;
}

/** `item` with its override, unless the server list moved on since the override settled. */
export function withOverride(
  item: OverviewItem,
  override: StudyOverride | undefined,
  serverItems: readonly OverviewItem[],
): OverviewItem {
  if (!override || (override.settledOn !== null && override.settledOn !== serverItems)) {
    return item;
  }
  return { ...item, ...override.patch };
}

export function applyOverrides(
  items: readonly OverviewItem[],
  overrides: ReadonlyMap<string, StudyOverride>,
): OverviewItem[] {
  if (overrides.size === 0) return [...items];
  return items.map((item) => withOverride(item, overrides.get(item.question_id), items));
}

/** Status after toggling flags locally (docs/questions.md §2.1); the server answer replaces it. */
export function optimisticStatus(
  item: OverviewItem,
  flags: { is_favorite?: boolean; needs_retry?: boolean },
): QuestionDotStatus {
  return deriveDotStatus({
    firstViewedAt: item.status === 'unseen' ? null : 'viewed',
    lastGradedResult: item.last_graded_result,
    needsRetry: flags.needs_retry ?? item.needs_retry,
    isFavorite: flags.is_favorite ?? item.is_favorite,
  });
}

export function heatmapChapters(placed: readonly PlacedQuestion[]): HeatmapChapter[] {
  const chapters: HeatmapChapter[] = [];
  let current: HeatmapChapter | undefined;
  for (const p of placed) {
    if (current?.id !== p.chapterKey) {
      current = {
        id: p.chapterKey,
        title: p.chapterTitle,
        ...(p.chapterNumber !== undefined ? { number: p.chapterNumber } : {}),
        questions: [],
      };
      chapters.push(current);
    }
    current.questions.push({
      id: p.item.question_id,
      number: p.number,
      type: p.item.question_type,
      status: p.item.status,
      isFavorite: p.item.is_favorite,
      preview: p.item.preview,
      lastGradedResult: p.item.last_graded_result,
      needsRetry: p.item.needs_retry,
      isPendingGrading: p.item.is_pending_grading,
    });
  }
  return chapters;
}
