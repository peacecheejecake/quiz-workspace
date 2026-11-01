// DOCVIEW (DOC-02-AC08/AC09): the text pane's page groups and where a PDF page leads in the text.
import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '../src/lib/documents/editor-api';
import { blockPageSpan, pageGroups, textTargetForPage } from '../src/lib/documents/text-groups';

const box = { x0: 0, y0: 0, x1: 1, y1: 1 };
const block = (id: string, pages: number[]): ContentBlock => ({
  block_id: id,
  caption_block_id: null,
  chapter_id: null,
  edited: false,
  heading_level: null,
  locations: pages.map((page) => ({ page, bbox: box })),
  ordinal: 0,
  page: pages[0] ?? 1,
  table: null,
  text: id,
  type: 'text',
  version: 'v',
});

// book-ko shape: a title page without blocks, page 2, a block running from 2 onto 3, page 4.
const blocks = [block('a', [2]), block('b', [2, 3]), block('c', [4]), block('d', [4])];

describe('pageGroups', () => {
  it('groups blocks under the page they start on, in reading order', () => {
    const groups = pageGroups(blocks);
    expect(groups.map((g) => g.page)).toEqual([2, 4]);
    expect(groups[0]?.items.map((i) => i.block.block_id)).toEqual(['a', 'b']);
    expect([...(groups[1]?.blockIds ?? [])]).toEqual(['c', 'd']);
    expect(pageGroups([])).toEqual([]);
  });

  it('labels only blocks that run onto later pages with their span', () => {
    expect(blockPageSpan(block('x', [2]))).toEqual([2, 2]);
    expect(blockPageSpan(block('y', [2, 3]))).toEqual([2, 3]);
    expect(blockPageSpan({ page: 5, locations: [] })).toEqual([5, 5]);
  });
});

describe('textTargetForPage', () => {
  const groups = pageGroups(blocks);

  it('goes to the page group, a block continuing onto the page, or the nearest earlier group', () => {
    expect(textTargetForPage(groups, 2)).toEqual({ kind: 'page', page: 2 });
    expect(textTargetForPage(groups, 3)).toEqual({ kind: 'block', blockId: 'b' });
    expect(textTargetForPage(groups, 4)).toEqual({ kind: 'page', page: 4 });
    expect(textTargetForPage(groups, 9)).toEqual({ kind: 'page', page: 4 });
  });

  it('has no target before the first block (a title page)', () => {
    expect(textTargetForPage(groups, 1)).toBeNull();
  });
});
