// Where "PDF에서 보기" lands for a hit (SEARCH-01-AC03). The API's `block_id` is the first block of
// the matched chunk; a chunk often spans several paragraphs (a whole section for keyword hits),
// so the reader would land on a paragraph before the one that actually contains the match. The
// excerpt text has no block boundaries, so the matched blocks of the hit's published revision are
// read and the block containing the first query term inside the matched passage wins. Any failure
// falls back to the API's location.
import { blockPage } from '@/lib/documents/outline';
import type { ContentBlock, SearchClient, SearchItem } from './client';
import { utf16Ranges } from './highlight';

export interface JumpTarget {
  readonly blockId: string;
  readonly page: number;
}

/** Upper bound of block reads per hit (a chunk spans a handful of blocks). */
export const MAX_JUMP_BLOCKS = 12;
const PASSAGE_PROBE_CHARS = 80;

/**
 * Text that pins the match to one block: from the start of the line holding the first query term
 * inside the matched passage up to the end of that term; without terms the passage's first line
 * (at most 80 characters). Lines never cross blocks (units are joined by blank lines, a caption
 * by a line break), so the probe is a substring of exactly the block it came from.
 */
export function jumpProbe(
  item: Pick<SearchItem, 'text' | 'highlights' | 'term_highlights'>,
): string | null {
  const { text } = item;
  const passages = utf16Ranges(text, item.highlights).sort((a, b) => a[0] - b[0]);
  const terms = utf16Ranges(text, item.term_highlights).sort((a, b) => a[0] - b[0]);
  const inPassage = ([s, e]: [number, number]) => passages.some(([ps, pe]) => s < pe && e > ps);
  const term = terms.find(inPassage) ?? (passages.length === 0 ? terms[0] : undefined);
  let probe: string;
  if (term) {
    const lineStart = text.lastIndexOf('\n', term[0] - 1) + 1;
    probe = text.slice(lineStart, term[1]);
  } else {
    const passage = passages[0];
    if (!passage) return null;
    const lineEnd = text.indexOf('\n', passage[0]);
    const end = Math.min(lineEnd === -1 ? text.length : lineEnd, passage[0] + PASSAGE_PROBE_CHARS);
    probe = text.slice(passage[0], end);
  }
  probe = probe.trim();
  return probe ? probe : null;
}

/** The first block (in reading order) whose text contains `probe`. */
export function pickJumpBlock(
  blocks: readonly Pick<ContentBlock, 'block_id' | 'text' | 'page' | 'locations'>[],
  probe: string,
): JumpTarget | null {
  const block = blocks.find((b) => b.text.includes(probe));
  return block ? { blockId: block.block_id, page: blockPage(block) } : null;
}

export const apiJumpTarget = (item: Pick<SearchItem, 'block_id' | 'page'>): JumpTarget => ({
  blockId: item.block_id,
  page: item.page,
});

/** Resolves the block to open for `item`; never rejects (falls back to the API location). */
export async function resolveJumpTarget(
  client: Pick<SearchClient, 'block'>,
  item: SearchItem,
  signal?: AbortSignal,
): Promise<JumpTarget> {
  const fallback = apiJumpTarget(item);
  const ids = [...new Set(item.block_ids)].slice(0, MAX_JUMP_BLOCKS);
  const probe = jumpProbe(item);
  if (ids.length <= 1 || probe === null) return fallback;
  try {
    const blocks = await Promise.all(
      ids.map((id) => client.block(item.document_id, id, item.revision_id, signal)),
    );
    return pickJumpBlock(blocks, probe) ?? fallback;
  } catch {
    return fallback;
  }
}
