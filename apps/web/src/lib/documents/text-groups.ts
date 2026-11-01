// The DOC-02 text pane grouped by page (DOCVIEW, DOC-02-AC08/AC09): blocks are grouped under the
// page they start on, and a PDF page maps to the place in the text that shows it. The source
// blocks of a confirmed imported question become one question item at the place of its first
// block (DOC-02-AC11). Pure, so it is unit-tested.
import type { DocumentQuestion } from './document-questions';
import type { ContentBlock } from './editor-api';
import { blockPage, viewerHighlights, type OutlineJump } from './outline';

export interface BlockItem {
  readonly kind: 'block';
  readonly block: ContentBlock;
}

export interface QuestionItem {
  readonly kind: 'question';
  readonly question: DocumentQuestion;
  /** The question's source blocks in reading order (shown on request, still correctable). */
  readonly blocks: readonly ContentBlock[];
}

export type TextItem = BlockItem | QuestionItem;

/** The blocks an item shows. */
export function itemBlocks(item: TextItem): readonly ContentBlock[] {
  return item.kind === 'block' ? [item.block] : item.blocks;
}

export interface PageGroup {
  /** The page every item of the group starts on. */
  readonly page: number;
  readonly items: readonly TextItem[];
  /** Ids of every block shown in the group. */
  readonly blockIds: ReadonlySet<string>;
}

/**
 * Blocks in reading order, grouped by the page they start on (groups in reading order too). The
 * blocks of each question form one item where its first block is; a block claimed by two
 * questions stays with the first one.
 */
export function pageGroups(
  blocks: readonly ContentBlock[],
  questions: readonly DocumentQuestion[] = [],
): PageGroup[] {
  const owner = new Map<string, DocumentQuestion>();
  for (const question of questions) {
    for (const id of question.blockIds) if (!owner.has(id)) owner.set(id, question);
  }
  const members = new Map<string, ContentBlock[]>();
  for (const block of blocks) {
    const question = owner.get(block.block_id);
    if (question) members.set(question.id, [...(members.get(question.id) ?? []), block]);
  }

  const groups: { page: number; items: TextItem[]; blockIds: Set<string> }[] = [];
  const byPage = new Map<number, (typeof groups)[number]>();
  const placed = new Set<string>();
  for (const block of blocks) {
    const question = owner.get(block.block_id);
    if (question && placed.has(question.id)) continue;
    const item: TextItem = question
      ? { kind: 'question', question, blocks: members.get(question.id) ?? [block] }
      : { kind: 'block', block };
    if (question) placed.add(question.id);
    const page = blockPage(block);
    let group = byPage.get(page);
    if (!group) {
      group = { page, items: [], blockIds: new Set() };
      byPage.set(page, group);
      groups.push(group);
    }
    group.items.push(item);
    for (const b of itemBlocks(item)) group.blockIds.add(b.block_id);
  }
  return groups;
}

/** The question item a block belongs to, if any. */
export function questionItemOf(
  groups: readonly PageGroup[],
  blockId: string,
): QuestionItem | undefined {
  for (const group of groups) {
    if (!group.blockIds.has(blockId)) continue;
    for (const item of group.items) {
      if (item.kind === 'question' && item.blocks.some((b) => b.block_id === blockId)) {
        return item;
      }
    }
  }
  return undefined;
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
      const block = itemBlocks(item).find((b) => b.locations.some((l) => l.page === page));
      if (block) return { kind: 'block', blockId: block.block_id };
    }
  }
  return earlier ? { kind: 'page', page: earlier.page } : null;
}

/**
 * The PDF highlights of the selection: a question's whole printed place (stem and options, one box
 * per page) when the selected block is one of its source blocks, else viewerHighlights.
 */
export function selectionHighlights(
  currentBlock: ContentBlock | undefined,
  jump: OutlineJump | null,
  blocks: readonly ContentBlock[],
  groups: readonly PageGroup[],
): ContentBlock['locations'] {
  const question = currentBlock ? questionItemOf(groups, currentBlock.block_id) : undefined;
  if (!question) return viewerHighlights(currentBlock, jump, blocks);
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
  for (const block of question.blocks) {
    for (const { page, bbox } of block.locations) {
      if (!bbox) continue;
      const box = boxes.get(page);
      boxes.set(
        page,
        box
          ? {
              x0: Math.min(box.x0, bbox.x0),
              y0: Math.min(box.y0, bbox.y0),
              x1: Math.max(box.x1, bbox.x1),
              y1: Math.max(box.y1, bbox.y1),
            }
          : { ...bbox },
      );
    }
  }
  return [...boxes.entries()].sort(([a], [b]) => a - b).map(([page, bbox]) => ({ page, bbox }));
}
