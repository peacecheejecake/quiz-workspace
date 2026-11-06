import type { ChapterPickerNode } from '@quiz/ui';

export interface PickableChapter {
  readonly id: string;
  readonly title: string;
  readonly level: number;
  readonly documentId: string;
  readonly documentTitle: string;
}

/**
 * The `ChapterPicker` tree of a pre-order chapter list. With several books each one is a group
 * row (a document's chapters may arrive apart), and the closed trigger names the book.
 */
export function chapterPickerNodes(chapters: readonly PickableChapter[]): ChapterPickerNode[] {
  const byDocument = new Map<string, PickableChapter[]>();
  for (const chapter of chapters) {
    const group = byDocument.get(chapter.documentId);
    if (group) group.push(chapter);
    else byDocument.set(chapter.documentId, [chapter]);
  }
  if (byDocument.size < 2) {
    return chapters.map((c) => ({ value: c.id, label: c.title, level: c.level }));
  }
  return [...byDocument].flatMap(([documentId, group]) => [
    {
      value: `document:${documentId}`,
      label: group[0]?.documentTitle ?? '',
      level: 0,
      group: true,
    },
    ...group.map((c) => ({
      value: c.id,
      label: c.title,
      level: c.level,
      triggerLabel: `${c.title} (${c.documentTitle})`,
    })),
  ]);
}
