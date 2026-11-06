// The chapter tree of `ChapterPicker` (docs/screens/ux12-chapter-picker.md), as plain data.

export interface ChapterPickerNode {
  /** Non-empty value, unique in the picker. */
  value: string;
  label: string;
  /** Outline level. Nesting comes from the pre-order list: a deeper level nests under the last shallower one. */
  level: number;
  /** Shown in the closed trigger instead of `label`, e.g. `제목 (문서)`. */
  triggerLabel?: string;
  /** A heading such as a document: opens and closes, starts open, cannot be chosen. */
  group?: boolean;
}

/** A fixed top-level choice above the tree: `전체 챕터`, `챕터 없음`. */
export interface ChapterPickerOption {
  value: string;
  label: string;
}

export interface TreeRow {
  readonly node: ChapterPickerNode;
  /** Index of the parent row, -1 at the top level. */
  readonly parent: number;
  /** 1 at the top level; one step per ancestor, so a level gap (1 → 3) indents once. */
  readonly depth: number;
  readonly hasChildren: boolean;
}

export interface VisibleRow {
  readonly index: number;
  readonly row: TreeRow;
  readonly position: number;
  readonly setSize: number;
  /** The filter matched this row's own title; an ancestor is only on screen for its child. */
  readonly matched: boolean;
  /** Has children on screen or to expand to. */
  readonly parent: boolean;
  readonly expanded: boolean;
}

/** One pass over the pre-order list with a stack of open ancestors. */
export function buildChapterTree(
  nodes: readonly ChapterPickerNode[],
  leading: readonly ChapterPickerOption[] = [],
): TreeRow[] {
  const rows: (Omit<TreeRow, 'hasChildren'> & { hasChildren: boolean })[] = leading.map(
    (option) => ({
      node: { ...option, level: 0 },
      parent: -1,
      depth: 1,
      hasChildren: false,
    }),
  );
  const stack: number[] = [];
  for (const node of nodes) {
    while (stack.length > 0 && (rows[stack.at(-1) as number] as TreeRow).node.level >= node.level) {
      stack.pop();
    }
    const parent = stack.at(-1) ?? -1;
    if (parent >= 0) (rows[parent] as { hasChildren: boolean }).hasChildren = true;
    stack.push(rows.length);
    rows.push({ node, parent, depth: stack.length, hasChildren: false });
  }
  return rows;
}

/** What starts open: groups and the ancestors of the chosen row. */
export function initialExpanded(rows: readonly TreeRow[], value: string): Set<string> {
  const expanded = new Set<string>();
  rows.forEach((row) => {
    if (row.node.group) expanded.add(row.node.value);
  });
  let index = rows.findIndex((row) => row.node.value === value);
  while (index >= 0) {
    index = (rows[index] as TreeRow).parent;
    if (index >= 0) expanded.add((rows[index] as TreeRow).node.value);
  }
  return expanded;
}

function matcher(query: string): (label: string) => boolean {
  const needle = query.normalize('NFC').trim().toLocaleLowerCase();
  return (label) => label.normalize('NFC').toLocaleLowerCase().includes(needle);
}

export function isFiltering(query: string): boolean {
  return query.trim() !== '';
}

/**
 * The rows on screen, in order. Without a query: rows whose ancestors are all open. With one: the
 * matching rows and their ancestors (open, whatever `expanded` says). Groups only match through
 * their rows.
 */
export function visibleRows(
  rows: readonly TreeRow[],
  expanded: ReadonlySet<string>,
  query: string,
): VisibleRow[] {
  const filtering = isFiltering(query);
  const shown = new Array<boolean>(rows.length).fill(false);
  const matched = new Set<number>();
  if (filtering) {
    const matches = matcher(query);
    rows.forEach((row, index) => {
      if (row.node.group || !matches(row.node.label)) return;
      matched.add(index);
      for (let at = index; at >= 0 && !shown[at]; at = (rows[at] as TreeRow).parent) {
        shown[at] = true;
      }
    });
  } else {
    rows.forEach((row, index) => {
      const parent = row.parent >= 0 ? (rows[row.parent] as TreeRow) : null;
      shown[index] =
        parent === null || (shown[row.parent] === true && expanded.has(parent.node.value));
    });
  }

  const shownChildren = new Map<number, number>();
  rows.forEach((row, index) => {
    if (shown[index]) shownChildren.set(row.parent, (shownChildren.get(row.parent) ?? 0) + 1);
  });
  const seen = new Map<number, number>();
  const out: VisibleRow[] = [];
  rows.forEach((row, index) => {
    if (!shown[index]) return;
    const position = (seen.get(row.parent) ?? 0) + 1;
    seen.set(row.parent, position);
    const parent = filtering ? shownChildren.has(index) : row.hasChildren;
    out.push({
      index,
      row,
      position,
      setSize: shownChildren.get(row.parent) ?? 1,
      matched: matched.has(index),
      parent,
      expanded: parent && (filtering || expanded.has(row.node.value)),
    });
  });
  return out;
}
