// DOM side of HighlightableText: turns the document selection into block offsets (HILITE-01-C09
// b, c). Elements marked `data-hl-skip` (hidden mark labels, footnote numbers) are not part of the
// text: they are left out of offsets and copied text.
import type { HighlightSelection, SelectionSource } from './model';

export const BLOCK_ATTR = 'data-hl-block';
export const SKIP_ATTR = 'data-hl-skip';

/** Text of a range without skipped content. */
export function rangeText(range: Range): string {
  // A range inside one skipped element clones without that element.
  const common = range.commonAncestorContainer;
  const around = common instanceof Element ? common : common.parentElement;
  if (around?.closest(`[${SKIP_ATTR}]`)) return '';
  const fragment = range.cloneContents();
  for (const skipped of fragment.querySelectorAll(`[${SKIP_ATTR}]`)) skipped.remove();
  return fragment.textContent ?? '';
}

/**
 * What copying `selection` yields: a reading region's `onCopy` writes `rangeText`, and everywhere
 * else the browser copies its own rendering of the selection, line breaks included.
 */
export function copyableText(selection: Selection): string {
  if (selection.rangeCount === 0) return '';
  const range = selection.getRangeAt(0);
  const start = range.startContainer;
  const element = start instanceof Element ? start : start.parentElement;
  return element?.closest('.qz-highlightable') ? rangeText(range) : selection.toString();
}

function blockElements(region: Element): HTMLElement[] {
  return [...region.querySelectorAll<HTMLElement>(`[${BLOCK_ATTR}]`)];
}

function owningBlock(region: Element, node: Node): HTMLElement | null {
  const el = node instanceof Element ? node : node.parentElement;
  const block = el?.closest<HTMLElement>(`[${BLOCK_ATTR}]`) ?? null;
  return block && region.contains(block) ? block : null;
}

/** Offset of a boundary point inside `block`'s text. */
export function offsetInBlock(block: Element, node: Node, offset: number): number {
  const range = block.ownerDocument.createRange();
  range.selectNodeContents(block);
  range.setEnd(node, offset);
  return rangeText(range).length;
}

interface Point {
  readonly block: HTMLElement;
  readonly offset: number;
}

/**
 * Resolves a boundary point to a block. A point between blocks (on a list or section element)
 * snaps forward for a start and backward for an end.
 */
function resolvePoint(region: Element, node: Node, offset: number, edge: 'start' | 'end') {
  const inside = owningBlock(region, node);
  if (inside) return { block: inside, offset: offsetInBlock(inside, node, offset) };
  if (!region.contains(node)) return null;
  const blocks = blockElements(region);
  const probe = node.ownerDocument?.createRange();
  if (!probe) return null;
  probe.setStart(node, offset);
  if (edge === 'start') {
    const next = blocks.find((b) => probe.comparePoint(b, 0) >= 0);
    return next ? { block: next, offset: 0 } : null;
  }
  const previous = blocks.findLast((b) => probe.comparePoint(b, b.childNodes.length) <= 0);
  return previous
    ? { block: previous, offset: offsetInBlock(previous, previous, previous.childNodes.length) }
    : null;
}

function measure(range: Range, atEnd: boolean, fallback: Element): DOMRect {
  if (typeof range.getClientRects === 'function') {
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
    const last = rects[rects.length - 1];
    if (atEnd && last) return last;
    if (typeof range.getBoundingClientRect === 'function') {
      const box = range.getBoundingClientRect();
      if (box.width > 0 || box.height > 0) return box;
    }
  }
  return fallback.getBoundingClientRect();
}

function restoreRange(range: Range | null): () => void {
  return () => {
    const selection = range?.startContainer.ownerDocument?.getSelection();
    if (!range || !selection) return;
    if (selection.rangeCount === 1 && selection.getRangeAt(0).toString() === range.toString()) {
      return;
    }
    selection.removeAllRanges();
    // A copy: the live selection must never change the remembered range.
    selection.addRange(range.cloneRange());
  };
}

export function selectionOf(
  range: Range,
  block: string | null,
  start: number,
  end: number,
  text: string,
  source: SelectionSource,
  anchorFallback: Element,
  extra: { highlightId?: string; keepsDomSelection?: boolean } = {},
): HighlightSelection {
  const saved = range.cloneRange();
  return {
    block,
    start,
    end,
    text,
    source,
    highlightId: extra.highlightId,
    getAnchorRect: () => measure(saved, source === 'touch', anchorFallback),
    restore: restoreRange(extra.keepsDomSelection === false ? null : saved),
  };
}

/**
 * The document selection as seen by `region`: null when it is empty or entirely outside; a
 * selection with `block: null` when it leaves one block (or the region). Skipped content at the
 * edges is trimmed away by the offsets.
 */
export function readSelection(region: Element, source: SelectionSource): HighlightSelection | null {
  const selection = region.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const startInside = region.contains(range.startContainer);
  const endInside = region.contains(range.endContainer);
  if (!startInside && !endInside) return null;
  const text = rangeText(range);
  if (text.trim() === '') return null;

  const start: Point | null = startInside
    ? resolvePoint(region, range.startContainer, range.startOffset, 'start')
    : null;
  let end: Point | null = endInside
    ? resolvePoint(region, range.endContainer, range.endOffset, 'end')
    : null;
  // A triple click selects a whole paragraph up to the start of the next one.
  if (start && end && end.block !== start.block && end.offset === 0) {
    const blocks = blockElements(region);
    if (blocks.indexOf(end.block) === blocks.indexOf(start.block) + 1) {
      end = {
        block: start.block,
        offset: offsetInBlock(start.block, start.block, start.block.childNodes.length),
      };
    }
  }
  if (start && end && start.block === end.block && end.offset > start.offset) {
    const id = start.block.getAttribute(BLOCK_ATTR) ?? '';
    return selectionOf(range, id, start.offset, end.offset, text, source, region);
  }
  return selectionOf(range, null, 0, 0, text, source, region);
}
