// Pure helpers of the DOC-02 outline tree and block ↔ page mapping (unit-tested).
import type { BlockDetail, ContentBlock, DocumentContent, OutlineItem } from './editor-api';

export interface OutlineRow {
  readonly node: OutlineItem;
  readonly depth: number;
  readonly parentId: string | null;
  readonly hasChildren: boolean;
  /** 1-based position among siblings (aria-posinset) and sibling count (aria-setsize). */
  readonly position: number;
  readonly siblings: number;
}

/**
 * Visible rows of the tree in reading order: children of collapsed nodes are left out. Rendered
 * as a flat list of treeitems with aria-level/posinset/setsize, so a parent's row never contains
 * its children (a click on the row is a click on that section only).
 */
export function visibleOutlineRows(
  items: readonly OutlineItem[],
  collapsed: ReadonlySet<string>,
): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const walk = (nodes: readonly OutlineItem[], depth: number, parentId: string | null) => {
    nodes.forEach((node, index) => {
      const hasChildren = node.children.length > 0;
      rows.push({
        node,
        depth,
        parentId,
        hasChildren,
        position: index + 1,
        siblings: nodes.length,
      });
      if (hasChildren && !collapsed.has(node.id)) walk(node.children, depth + 1, node.id);
    });
  };
  walk(items, 1, null);
  return rows;
}

/** First PDF page of a block (its first location, else the block's page). */
export function blockPage(block: Pick<ContentBlock, 'page' | 'locations'>): number {
  return block.locations[0]?.page ?? block.page;
}

/**
 * The block an outline entry leads to: the section's first body block (the text a reader wants
 * to see), else its heading, else the first block on the section's page.
 */
export function targetBlockFor(
  node: Pick<OutlineItem, 'id' | 'block_id' | 'page'>,
  blocks: readonly ContentBlock[],
): ContentBlock | undefined {
  return (
    blocks.find((b) => b.chapter_id === node.id && b.type !== 'heading') ??
    blocks.find((b) => b.block_id === node.block_id) ??
    (node.page != null ? blocks.find((b) => blockPage(b) >= (node.page ?? 0)) : undefined)
  );
}

/** Id of the outline node a block belongs to (its chapter), if it is in the tree. */
export function sectionOf(
  block: Pick<ContentBlock, 'chapter_id'> | undefined,
  items: readonly OutlineItem[],
): string | null {
  if (!block?.chapter_id) return null;
  const stack = [...items];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.id === block.chapter_id) return node.id;
    stack.push(...node.children);
  }
  return null;
}

/** Ids of every ancestor of `id` (to expand the path to the current section). */
export function ancestorsOf(id: string, items: readonly OutlineItem[]): string[] {
  const path: string[] = [];
  const visit = (nodes: readonly OutlineItem[]): boolean => {
    for (const node of nodes) {
      if (node.id === id) return true;
      path.push(node.id);
      if (visit(node.children)) return true;
      path.pop();
    }
    return false;
  };
  return visit(items) ? path : [];
}

/** Locations of a block on `page` (a block may span pages). */
export function locationsOn(
  block: Pick<ContentBlock, 'locations'> | undefined,
  page: number,
): ContentBlock['locations'] {
  return block ? block.locations.filter((l) => l.page === page && l.bbox !== null) : [];
}

/** Parses `?page=N` (1-based); null when missing or not a positive integer. */
export function parsePageParam(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d{1,6}$/.test(raw)) return null;
  const page = Number(raw);
  return page >= 1 ? page : null;
}

/**
 * The address-bar query for the viewer state: `page` always, `block` while a block is the
 * selection (a pure page navigation clears it, so reload/share never reopens a stale block).
 * Other parameters are kept.
 */
export function viewerSearch(search: string, page: number, blockId: string | null): string {
  const params = new URLSearchParams(search);
  params.set('page', String(page));
  if (blockId) params.set('block', blockId);
  else params.delete('block');
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** Content after a successful correction: the saved block and the revision it now lives in. */
export function applySavedBlock(content: DocumentContent, saved: BlockDetail): DocumentContent {
  return {
    ...content,
    revision: saved.revision,
    blocks: content.blocks.map((b) => (b.block_id === saved.block.block_id ? saved.block : b)),
  };
}
