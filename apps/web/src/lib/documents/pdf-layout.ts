// Geometry and render scheduling of the DOC-02 continuous PDF viewer (DOCVIEW, DOC-02-AC07/AC08),
// kept pure so it is unit-tested without PDF.js or a DOM. Pages are stacked vertically; each has
// a placeholder box from its PDF size (page 1's size until the page itself was read), and only
// the pages on screen plus a few neighbours are drawn.

export interface PageSize {
  /** PDF points at scale 1. */
  readonly width: number;
  readonly height: number;
}

/** Space around the stack and between pages (CSS px, unscaled). */
export const PAGE_PADDING = 16;
export const PAGE_GAP = 12;
/** The current page is the one under this fraction of the viewport height (DOC-02-AC08). */
export const READING_LINE = 0.25;
/** Pages beyond the visible ones that are drawn ahead of time. */
export const PREFETCH_AHEAD = 2;
export const PREFETCH_BEHIND = 1;
/** Drawn pages this far outside the visible range keep their canvas attached. */
export const KEEP_ATTACHED = 3;
/** Drawn pages kept in memory (detached ones are redrawn from here without PDF.js). */
export const RENDER_CACHE_PAGES = 12;
/** Largest canvas we allocate (pixels); Safari refuses canvases above ~16.7M pixels. */
export const MAX_CANVAS_PIXELS = 4096 * 4096;

export interface PageLayout {
  /** Top of page n (1-based) at index n - 1, in CSS px from the top of the scroll content. */
  readonly tops: readonly number[];
  readonly heights: readonly number[];
  readonly widths: readonly number[];
  readonly totalHeight: number;
  readonly maxWidth: number;
}

/** Stacked boxes of `count` pages at `scale`; `sizes` overrides the default size per page. */
export function layoutPages(
  count: number,
  fallback: PageSize,
  sizes: ReadonlyMap<number, PageSize>,
  scale: number,
): PageLayout {
  const tops: number[] = [];
  const heights: number[] = [];
  const widths: number[] = [];
  let y = PAGE_PADDING;
  let maxWidth = 0;
  for (let n = 1; n <= count; n += 1) {
    const size = sizes.get(n) ?? fallback;
    const height = Math.floor(size.height * scale);
    const width = Math.floor(size.width * scale);
    tops.push(y);
    heights.push(height);
    widths.push(width);
    maxWidth = Math.max(maxWidth, width);
    y += height + PAGE_GAP;
  }
  const totalHeight = count > 0 ? y - PAGE_GAP + PAGE_PADDING : 0;
  return { tops, heights, widths, totalHeight, maxWidth };
}

/** The page (1-based) whose box, including the gap below it, contains `y`; clamped. */
export function pageAt(layout: PageLayout, y: number): number {
  const { tops } = layout;
  if (tops.length === 0) return 1;
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((tops[mid] ?? 0) <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export interface Viewport {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

/** First and last page that intersect the viewport. */
export function visiblePages(layout: PageLayout, view: Viewport): { first: number; last: number } {
  const first = pageAt(layout, view.scrollTop);
  const last = pageAt(layout, view.scrollTop + Math.max(view.clientHeight - 1, 0));
  return { first, last };
}

/**
 * The current page for a scroll position: the page under the reading line, or the last page once
 * the end is reached (a short last page may never cross the line).
 */
export function currentPageAt(layout: PageLayout, view: Viewport): number {
  const count = layout.tops.length;
  if (count === 0) return 1;
  if (view.scrollTop > 0 && view.scrollTop + view.clientHeight >= view.scrollHeight - 1) {
    return count;
  }
  return pageAt(layout, view.scrollTop + view.clientHeight * READING_LINE);
}

/** Scroll position that puts the top of page `n` at the top of the viewport. */
export function scrollTopForPage(layout: PageLayout, n: number): number {
  const top = layout.tops[Math.min(Math.max(n, 1), layout.tops.length) - 1] ?? 0;
  return Math.max(top - PAGE_PADDING, 0);
}

/**
 * Pages to draw, most urgent first: the visible pages from the current one outwards, then the
 * pages after and before them (neighbour prefetch).
 */
export function renderOrder(first: number, last: number, current: number, count: number): number[] {
  const order: number[] = [];
  const add = (n: number) => {
    if (n >= 1 && n <= count && !order.includes(n)) order.push(n);
  };
  const start = Math.min(Math.max(current, first), last);
  add(start);
  for (let d = 1; d <= last - first; d += 1) {
    if (start + d <= last) add(start + d);
    if (start - d >= first) add(start - d);
  }
  for (let d = 1; d <= PREFETCH_AHEAD; d += 1) add(last + d);
  for (let d = 1; d <= PREFETCH_BEHIND; d += 1) add(first - d);
  return order;
}

/** Pages whose drawn canvas stays attached (visible range ± KEEP_ATTACHED). */
export function attachedRange(first: number, last: number, count: number): [number, number] {
  return [Math.max(first - KEEP_ATTACHED, 1), Math.min(last + KEEP_ATTACHED, count)];
}

/** Device pixel ratio for a page of `width` × `height` CSS px, capped to MAX_CANVAS_PIXELS. */
export function canvasRatio(width: number, height: number, devicePixelRatio: number): number {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const area = Math.max(width * height, 1);
  return Math.min(ratio, Math.sqrt(MAX_CANVAS_PIXELS / area));
}

/**
 * Least-recently-used store of drawn pages. `keep` pages are never evicted (they are on screen);
 * an evicted entry is handed to `release` to free its memory.
 */
export class RenderCache<T> {
  private readonly entries = new Map<number, { readonly scale: number; readonly value: T }>();

  constructor(
    private readonly capacity: number,
    private readonly release: (value: T) => void,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** The drawn page at exactly `scale`, marked as recently used. */
  get(page: number, scale: number): T | undefined {
    const entry = this.entries.get(page);
    if (!entry || entry.scale !== scale) return undefined;
    this.entries.delete(page);
    this.entries.set(page, entry);
    return entry.value;
  }

  /** Any drawn version of the page (e.g. at the previous zoom), without touching the order. */
  peek(page: number): T | undefined {
    return this.entries.get(page)?.value;
  }

  set(page: number, scale: number, value: T, keep: (page: number) => boolean): void {
    const previous = this.entries.get(page);
    if (previous && previous.value !== value) this.release(previous.value);
    this.entries.delete(page);
    this.entries.set(page, { scale, value });
    for (const [n, entry] of this.entries) {
      if (this.entries.size <= this.capacity) break;
      if (n === page || keep(n)) continue;
      this.entries.delete(n);
      this.release(entry.value);
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) this.release(entry.value);
    this.entries.clear();
  }
}
