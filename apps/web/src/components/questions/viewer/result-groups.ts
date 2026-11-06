import { RESULT_WORDS, type RunResultItem } from '@/lib/questions/practice-runs';

export interface ResultGroup {
  readonly key: string;
  readonly title: string;
  readonly items: readonly RunResultItem[];
}

export interface ResultMark {
  /** What the table's cell shows: text, never color alone. */
  readonly mark: string;
  /** The result in words, for assistive tech. */
  readonly word: string;
  readonly tone: 'correct' | 'incorrect' | null;
}

export function resultMark(item: RunResultItem): ResultMark {
  if (!item.available) return { mark: '불가', word: '더 이상 풀 수 없는 문제', tone: null };
  switch (item.result) {
    case 'correct':
      return { mark: 'O', word: RESULT_WORDS.correct, tone: 'correct' };
    case 'incorrect':
      return { mark: 'X', word: RESULT_WORDS.incorrect, tone: 'incorrect' };
    case 'pending':
      return { mark: '대기', word: RESULT_WORDS.pending, tone: null };
    case 'skipped':
      return { mark: '–', word: RESULT_WORDS.skipped, tone: null };
    case 'reset':
      return { mark: '초기화', word: RESULT_WORDS.reset, tone: null };
    default:
      return { mark: '–', word: '아직 풀지 않음', tone: null };
  }
}

/** Group only the loaded results; each page can be displayed without loading the entire run. */
export function groupResults(items: readonly RunResultItem[]): ResultGroup[] {
  const groups = new Map<string, { key: string; title: string; items: RunResultItem[] }>();
  for (const item of items) {
    const key = item.chapter_id ?? 'no-chapter';
    let group = groups.get(key);
    if (!group) {
      const number = item.chapter_number === null ? '' : `${item.chapter_number}장`;
      const title =
        item.chapter_title?.startsWith(number) && number
          ? item.chapter_title
          : [number, item.chapter_title].filter(Boolean).join(' ') || '장 없음';
      group = { key, title, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  const ungrouped = groups.get('no-chapter');
  groups.delete('no-chapter');
  return [...groups.values(), ...(ungrouped ? [ungrouped] : [])];
}
