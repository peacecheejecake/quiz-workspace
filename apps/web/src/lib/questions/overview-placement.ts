// QOV-01 heatmap placement: overview items in heatmap order with the chapter each one is shown
// under, its display number and the `3장 12번 문제` title. Pure; shared by the server loader
// (filter-independent deep links) and the client screen.
import type { OverviewChapter, OverviewItem, QuestionOverview } from './overview-data';

export const NO_CHAPTER_KEY = 'none';

/** A heatmap question with the chapter it is shown under (panel title, labels). */
export interface PlacedQuestion {
  readonly item: OverviewItem;
  readonly number: string;
  readonly chapterKey: string;
  readonly chapterTitle: string;
  readonly chapterNumber: number | undefined;
}

export function chapterKey(id: string | null): string {
  return id ?? NO_CHAPTER_KEY;
}

/** Questions in heatmap order, grouped by the response's `chapters` (API order). */
export function placeQuestions(
  chapters: readonly OverviewChapter[],
  items: readonly OverviewItem[],
): PlacedQuestion[] {
  const byChapter = new Map<string, OverviewItem[]>();
  for (const item of items) {
    const key = chapterKey(item.chapter_id);
    const list = byChapter.get(key);
    if (list) list.push(item);
    else byChapter.set(key, [item]);
  }
  const placed: PlacedQuestion[] = [];
  const seen = new Set<string>();
  const place = (key: string, title: string, number: number | null) => {
    seen.add(key);
    (byChapter.get(key) ?? []).forEach((item, index) => {
      placed.push({
        item,
        // Unnumbered questions fall back to their position in the chapter.
        number: String(item.question_number ?? index + 1),
        chapterKey: key,
        chapterTitle: title,
        chapterNumber: number ?? undefined,
      });
    });
  };
  for (const chapter of chapters) place(chapterKey(chapter.id), chapter.title, chapter.number);
  // Defensive: items whose group is missing from `chapters` still get a dot.
  for (const key of byChapter.keys()) {
    if (!seen.has(key)) place(key, key === NO_CHAPTER_KEY ? '챕터 없음' : '챕터', null);
  }
  return placed;
}

/**
 * `3장 12번 문제` (or `<chapter title> 12번 문제`): the panel title, matching the dot label's
 * title (@quiz/ui `questionDotLabel`) so the panel names the question the dot announced.
 */
export function placedTitle(p: PlacedQuestion): string {
  const chapter = p.chapterNumber !== undefined ? `${p.chapterNumber}장` : p.chapterTitle;
  return `${chapter} ${p.number}번 문제`;
}

/** The placement of `questionId` in `overview` (unfiltered: its position is stable), or null. */
export function findPlaced(
  overview: Pick<QuestionOverview, 'chapters' | 'items'>,
  questionId: string,
): PlacedQuestion | null {
  if (!overview.items.some((i) => i.question_id === questionId)) return null;
  return (
    placeQuestions(overview.chapters, overview.items).find(
      (p) => p.item.question_id === questionId,
    ) ?? null
  );
}
