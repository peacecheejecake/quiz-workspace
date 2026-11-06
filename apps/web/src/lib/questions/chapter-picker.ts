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

export interface OutlineChoice {
  readonly value: string;
  readonly title: string;
  /** Top level first, without the chapter itself. */
  readonly ancestors: readonly { readonly id: string; readonly title: string }[];
}

/**
 * The home filter's tree (CHMAN-01-AC07): the Heatmap's chapter groups at their outline depth. An
 * ancestor without a group of its own has no questions to filter by, so it is a heading row.
 */
export function outlineChoiceNodes(choices: readonly OutlineChoice[]): ChapterPickerNode[] {
  const chapters = new Set(choices.map((c) => c.value));
  const headings = new Set<string>();
  return choices.flatMap((choice) => [
    ...choice.ancestors.flatMap((ancestor, index) => {
      if (chapters.has(ancestor.id) || headings.has(ancestor.id)) return [];
      headings.add(ancestor.id);
      return [
        {
          value: `ancestor:${ancestor.id}`,
          label: ancestor.title,
          level: index + 1,
          group: true,
        },
      ];
    }),
    { value: choice.value, label: choice.title, level: choice.ancestors.length + 1 },
  ]);
}
