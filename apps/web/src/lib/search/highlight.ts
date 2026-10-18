// Highlight segmentation of a search excerpt (SEARCH-01). The API reports `highlights` (the
// matched passage) and `term_highlights` (query terms) as [start, end) offsets in *characters*
// (Python code points); JS strings index UTF-16 code units, so offsets are converted before the
// text is cut. Ranges may overlap, nest or be out of bounds; the result always covers the whole
// text exactly once, in order.

export interface TextRange {
  readonly start: number;
  readonly end: number;
}

export interface HighlightSegment {
  readonly text: string;
  /** Inside the matched passage. */
  readonly passage: boolean;
  /** Inside a query term. */
  readonly term: boolean;
}

/** UTF-16 offset of every code point boundary: index i = start of code point i (plus the end). */
function codePointOffsets(text: string): number[] {
  const offsets = [0];
  let unit = 0;
  for (const char of text) {
    unit += char.length;
    offsets.push(unit);
  }
  return offsets;
}

function toUnits(ranges: readonly TextRange[], offsets: readonly number[]): [number, number][] {
  const max = offsets.length - 1;
  const out: [number, number][] = [];
  for (const { start, end } of ranges) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const s = Math.min(Math.max(Math.trunc(start), 0), max);
    const e = Math.min(Math.max(Math.trunc(end), 0), max);
    if (e > s) out.push([offsets[s] ?? 0, offsets[e] ?? 0]);
  }
  return out;
}

/** `ranges` (code point offsets) as UTF-16 [start, end) pairs of `text`; empty/invalid dropped. */
export function utf16Ranges(text: string, ranges: readonly TextRange[]): [number, number][] {
  return toUnits(ranges, codePointOffsets(text));
}

const covers = (ranges: readonly [number, number][], from: number, to: number) =>
  ranges.some(([s, e]) => s <= from && to <= e);

/** Splits `text` into runs that are uniformly inside/outside the passage and term ranges. */
export function segmentHighlights(
  text: string,
  passage: readonly TextRange[],
  terms: readonly TextRange[],
): HighlightSegment[] {
  if (!text) return [];
  const offsets = codePointOffsets(text);
  const passageUnits = toUnits(passage, offsets);
  const termUnits = toUnits(terms, offsets);
  const cuts = new Set<number>([0, text.length]);
  for (const [s, e] of [...passageUnits, ...termUnits]) {
    cuts.add(s);
    cuts.add(e);
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const segments: HighlightSegment[] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const from = sorted[i] ?? 0;
    const to = sorted[i + 1] ?? 0;
    const segment = {
      text: text.slice(from, to),
      passage: covers(passageUnits, from, to),
      term: covers(termUnits, from, to),
    };
    const last = segments.at(-1);
    if (last && last.passage === segment.passage && last.term === segment.term) {
      segments[segments.length - 1] = { ...last, text: last.text + segment.text };
    } else {
      segments.push(segment);
    }
  }
  return segments;
}
