// Plain module (no 'use client'): the note search of CHNOTE-02 (CHNOTE-02-C04). It runs on the
// blocks' text — the rendered text without highlight labels or footnote numbers — so a result can
// cross a highlight mark boundary.

/** Results stop here; the count then reads "1000+". */
export const FIND_IN_NOTE_LIMIT = 1000;

export interface FindBlock {
  readonly id: string;
  readonly text: string;
}

export interface FoundMatch {
  readonly block: string;
  /** UTF-16 offsets into the block's original text, end exclusive. */
  readonly start: number;
  readonly end: number;
}

export interface FindResult {
  readonly matches: readonly FoundMatch[];
  /** More than `FIND_IN_NOTE_LIMIT` results exist; only the first ones are returned. */
  readonly capped: boolean;
}

interface Folded {
  readonly text: string;
  /** For each folded UTF-16 unit: [start, end) of the original cluster it came from. */
  readonly from: readonly number[];
  readonly to: readonly number[];
}

// A grapheme (base + combining marks, decomposed Hangul jamo) folds as one unit, so NFKC can
// compose it.
const CLUSTER = /\P{M}\p{M}*|\p{M}+/gu;
const graphemes =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function clusters(text: string): { segment: string; index: number }[] {
  if (graphemes) return [...graphemes.segment(text)];
  return [...text.matchAll(CLUSTER)].map((m) => ({ segment: m[0], index: m.index }));
}

/**
 * One grapheme in search form: NFKC + lower case, with the Greek final sigma (which only
 * whole-string lower-casing produces) folded to σ, so the result never depends on context.
 */
function foldCluster(segment: string): string {
  return segment.normalize('NFKC').toLowerCase().replaceAll('ς', 'σ');
}

/**
 * Case- and width-insensitive form (NFKC + lower case, grapheme by grapheme); spacing is kept as
 * is. Text and query are folded with this same function, so they always compare alike.
 */
export function foldForSearch(text: string): string {
  return fold(text).text;
}

function fold(text: string): Folded {
  let out = '';
  const from: number[] = [];
  const to: number[] = [];
  for (const { segment, index: start } of clusters(text)) {
    const end = start + segment.length;
    const f = foldCluster(segment);
    out += f;
    from.push(...new Array<number>(f.length).fill(start));
    to.push(...new Array<number>(f.length).fill(end));
  }
  return { text: out, from, to };
}

/**
 * Finds `query` in `blocks` (in order): case-insensitive, full/half width equal (NFKC), spaces
 * compared as typed. Results never overlap and never cross blocks; an empty query finds nothing.
 */
export function findInNote(
  blocks: readonly FindBlock[],
  query: string,
  limit = FIND_IN_NOTE_LIMIT,
): FindResult {
  const needle = foldForSearch(query);
  const matches: FoundMatch[] = [];
  if (needle.length === 0) return { matches, capped: false };
  for (const block of blocks) {
    const folded = fold(block.text);
    let at = folded.text.indexOf(needle);
    while (at !== -1) {
      if (matches.length === limit) return { matches, capped: true };
      const start = folded.from[at] ?? 0;
      const end = folded.to[at + needle.length - 1] ?? start;
      matches.push({ block: block.id, start, end });
      at = folded.text.indexOf(needle, at + needle.length);
    }
  }
  return { matches, capped: false };
}

/** Result count as shown: "n", or "1000+" when capped. */
export function matchCountLabel(count: number, capped: boolean): string {
  return capped ? `${count}+` : String(count);
}
