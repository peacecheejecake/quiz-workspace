// The DOC-02 text pane grouped by page (DOCVIEW, DOC-02-AC08/AC09): blocks are grouped under the
// page they start on, and a PDF page maps to the place in the text that shows it. Pure, so it is
// unit-tested.
import type { ContentBlock } from './editor-api';
import { blockPage } from './outline';

export interface BlockItem {
  readonly kind: 'block';
  readonly block: ContentBlock;
}

export type TextItem = BlockItem;

export interface PageGroup {
  /** The page every item of the group starts on. */
  readonly page: number;
  readonly items: readonly TextItem[];
  /** Ids of every block shown in the group. */
  readonly blockIds: ReadonlySet<string>;
}

/** Blocks in reading order, grouped by the page they start on (groups in reading order too). */
export function pageGroups(blocks: readonly ContentBlock[]): PageGroup[] {
  const groups: { page: number; items: TextItem[]; blockIds: Set<string> }[] = [];
  const byPage = new Map<number, (typeof groups)[number]>();
  for (const block of blocks) {
    const page = blockPage(block);
    let group = byPage.get(page);
    if (!group) {
      group = { page, items: [], blockIds: new Set() };
      byPage.set(page, group);
      groups.push(group);
    }
    group.items.push({ kind: 'block', block });
    group.blockIds.add(block.block_id);
  }
  return groups;
}

/** First and last page a block covers (its located parts), for the `N–M쪽` label. */
export function blockPageSpan(block: Pick<ContentBlock, 'page' | 'locations'>): [number, number] {
  const pages = block.locations.map((l) => l.page);
  const first = blockPage(block);
  return [first, pages.length > 0 ? Math.max(first, ...pages) : first];
}

export type TextTarget =
  | { readonly kind: 'page'; readonly page: number }
  | { readonly kind: 'block'; readonly blockId: string };

/**
 * Where the text pane goes for PDF page `page`: that page's group heading; else the first block
 * that continues onto the page (no block starts there); else the nearest earlier group; else
 * nothing (e.g. a title page before the first block).
 */
export function textTargetForPage(groups: readonly PageGroup[], page: number): TextTarget | null {
  let earlier: PageGroup | null = null;
  for (const group of groups) {
    if (group.page === page) return { kind: 'page', page };
    if (group.page < page && (!earlier || group.page > earlier.page)) earlier = group;
  }
  for (const group of groups) {
    for (const item of group.items) {
      if (item.block.locations.some((l) => l.page === page)) {
        return { kind: 'block', blockId: item.block.block_id };
      }
    }
  }
  return earlier ? { kind: 'page', page: earlier.page } : null;
}
