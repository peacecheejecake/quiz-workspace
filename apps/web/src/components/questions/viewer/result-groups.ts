import type { RunResultItem } from '@/lib/questions/practice-runs';

export interface ResultGroup {
  readonly key: string;
  readonly title: string;
  readonly items: readonly RunResultItem[];
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
