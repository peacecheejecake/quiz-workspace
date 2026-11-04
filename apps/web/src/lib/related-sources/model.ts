// RELSRC-01 관련 본문 copy and pure helpers (docs/screens/related-sources.md).
import type { TextRange } from '@/lib/search/highlight';

export const RELATED_TEXT = {
  title: '관련 본문',
  loading: '관련 본문을 찾는 중입니다',
  empty: '관련 본문을 찾지 못했습니다.',
  failed: '관련 본문을 불러오지 못했습니다.',
  retry: '다시 시도',
  degraded: '의미 검색을 일시적으로 사용할 수 없어 키워드 결과만 표시합니다',
  sourceBadge: '문제 출처',
  stale: '이전 발행본',
  pdf: 'PDF',
  excerptLoading: '발췌를 불러오는 중…',
  excerptFailed: '발췌를 불러오지 못했습니다. PDF에서 보세요.',
} as const;

export const relatedCount = (n: number) => `관련 본문 ${n}개`;

/** `p.12` or `p.12–13`. */
export function pageRange(start: number, end: number): string {
  return end > start ? `p.${start}–${end}` : `p.${start}`;
}

/** Document title, chapter and pages of a row, e.g. "교재 · 1장 · p.2". */
export function rowLocation(source: {
  readonly document_title: string;
  readonly chapter_title: string | null;
  readonly page_start: number;
  readonly page_end: number;
}): string {
  return [
    source.document_title,
    source.chapter_title,
    pageRange(source.page_start, source.page_end),
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The ranges (code points, like the API's) of the excerpt's marked words in the full block text:
 * the excerpt panel shows the whole passage, so the words the list marked are marked there too.
 */
export function termRangesIn(
  full: string,
  excerpt: string,
  highlights: readonly TextRange[],
): TextRange[] {
  const excerptPoints = Array.from(excerpt);
  const words = new Set<string>();
  for (const { start, end } of highlights) {
    const word = excerptPoints.slice(start, end).join('');
    if (word.trim()) words.add(word);
  }
  // UTF-16 index → code point index.
  const pointIndex = (unit: number) => Array.from(full.slice(0, unit)).length;
  const ranges: TextRange[] = [];
  for (const word of words) {
    const length = Array.from(word).length;
    for (let at = full.indexOf(word); at !== -1; at = full.indexOf(word, at + word.length)) {
      const start = pointIndex(at);
      ranges.push({ start, end: start + length });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}
