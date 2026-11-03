// Plain module (no 'use client'): the data model and pure range logic of the shared highlight tool
// (docs/design-system.md §5.2, HILITE-01). Offsets are UTF-16 indices into a block's text (the
// rendered text without footnote numbers or hidden labels), end exclusive.
import type { ReactNode } from 'react';

export const HIGHLIGHT_COLORS = ['yellow', 'blue', 'pink'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

/** Korean color names: menu items, hidden mark labels, chips. */
export const highlightColorLabels: Readonly<Record<HighlightColor, string>> = {
  yellow: '노랑',
  blue: '파랑',
  pink: '분홍',
};

/** Inline emphasis inside a block's text (note items keep their **bold** / *italic*). */
export interface TextEmphasis {
  readonly start: number;
  readonly end: number;
  readonly kind: 'strong' | 'em';
}

/** One highlightable paragraph: a note item or an explanation paragraph. */
export interface TextBlock {
  readonly id: string;
  readonly text: string;
  readonly emphasis?: readonly TextEmphasis[];
  /**
   * Content rendered before / after the text (e.g. footnote numbers). It is skipped by offsets and
   * by copying (`data-hl-skip`); it may be interactive.
   */
  readonly prefix?: ReactNode;
  readonly suffix?: ReactNode;
}

export interface TextHighlight {
  readonly id: string;
  readonly block: string;
  readonly start: number;
  readonly end: number;
  readonly color: HighlightColor;
}

/** A search result range (CHNOTE-02); at most one is `current`. */
export interface TextMatch {
  readonly block: string;
  readonly start: number;
  readonly end: number;
  readonly current?: boolean;
}

export interface TextRange {
  readonly block: string;
  readonly start: number;
  readonly end: number;
}

export type SelectionSource = 'mouse' | 'touch' | 'keyboard' | 'press';

/**
 * What the reader picked. `block` is null when the selection crosses blocks (the menu then only
 * offers `복사`). `getAnchorRect` measures the selection now (virtual anchor of the menu); touch
 * selections anchor to the end of the selection.
 */
export interface HighlightSelection {
  readonly block: string | null;
  readonly start: number;
  readonly end: number;
  /** Selected text without hidden labels and footnote numbers (what `복사` copies). */
  readonly text: string;
  readonly source: SelectionSource;
  /** Set when the reader pressed an existing highlight without selecting. */
  readonly highlightId?: string;
  readonly getAnchorRect: () => DOMRect;
  /** Puts the selection back into the document (after focus moved through the menu). */
  readonly restore: () => void;
}

/** A change the menu asks the screen to make (one request each, HILITE-01-C03/C04). */
export type HighlightAction =
  | {
      readonly type: 'create';
      readonly block: string;
      readonly start: number;
      readonly end: number;
      readonly color: HighlightColor;
      /** Overlapping highlights merged into the new one (`replace_ids`). */
      readonly replaceIds: readonly string[];
    }
  | { readonly type: 'recolor'; readonly id: string; readonly color: HighlightColor }
  | { readonly type: 'remove'; readonly ids: readonly string[] };

const overlaps = (a: TextRange, b: TextRange) =>
  a.block === b.block && a.start < b.end && b.start < a.end;

/**
 * The highlights of one block that can be drawn: clamped to the text, non-empty, sorted, and
 * without overlaps (a later overlapping highlight is dropped; the API never returns any).
 */
export function drawableHighlights(
  highlights: readonly TextHighlight[],
  block: TextBlock,
): TextHighlight[] {
  const own = highlights
    .filter((h) => h.block === block.id)
    .map((h) => ({ ...h, start: Math.max(0, h.start), end: Math.min(block.text.length, h.end) }))
    .filter((h) => h.end > h.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: TextHighlight[] = [];
  for (const h of own) {
    const last = out[out.length - 1];
    if (!last || h.start >= last.end) out.push(h);
  }
  return out;
}

/** Highlights the range touches (same block, at least one shared character). */
export function overlappingHighlights(
  highlights: readonly TextHighlight[],
  range: TextRange,
): TextHighlight[] {
  return highlights.filter((h) => overlaps(h, range));
}

/** The highlight covering exactly this range, if any (its color item is checked). */
export function exactHighlight(
  highlights: readonly TextHighlight[],
  range: TextRange,
): TextHighlight | undefined {
  return highlights.find(
    (h) => h.block === range.block && h.start === range.start && h.end === range.end,
  );
}

/**
 * The action for choosing `color` on `range`: recolor an exactly matching highlight (null when it
 * already has that color), otherwise create one covering the range and every highlight it
 * overlaps, replacing them (HILITE-01 "색 고르기").
 */
export function colorAction(
  highlights: readonly TextHighlight[],
  range: TextRange,
  color: HighlightColor,
): HighlightAction | null {
  const exact = exactHighlight(highlights, range);
  if (exact) return exact.color === color ? null : { type: 'recolor', id: exact.id, color };
  const merged = overlappingHighlights(highlights, range);
  return {
    type: 'create',
    block: range.block,
    start: Math.min(range.start, ...merged.map((h) => h.start)),
    end: Math.max(range.end, ...merged.map((h) => h.end)),
    color,
    replaceIds: merged.map((h) => h.id),
  };
}

export interface TextSegment {
  readonly start: number;
  readonly end: number;
  readonly highlight?: TextHighlight;
  /** Index of the search match in the block's match list. */
  readonly match?: number;
  readonly emphasis?: TextEmphasis['kind'];
}

/** Splits a block's text at every highlight, match and emphasis boundary. */
export function textSegments(
  text: string,
  highlights: readonly TextHighlight[],
  matches: readonly TextMatch[],
  emphasis: readonly TextEmphasis[] = [],
): TextSegment[] {
  const cuts = new Set<number>([0, text.length]);
  for (const r of [...highlights, ...matches, ...emphasis]) {
    cuts.add(Math.max(0, Math.min(text.length, r.start)));
    cuts.add(Math.max(0, Math.min(text.length, r.end)));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const segments: TextSegment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i] ?? 0;
    const end = points[i + 1] ?? 0;
    if (end <= start) continue;
    const inside = (r: { start: number; end: number }) => r.start <= start && end <= r.end;
    const match = matches.findIndex(inside);
    segments.push({
      start,
      end,
      highlight: highlights.find(inside),
      match: match === -1 ? undefined : match,
      emphasis: emphasis.find(inside)?.kind,
    });
  }
  return segments;
}
