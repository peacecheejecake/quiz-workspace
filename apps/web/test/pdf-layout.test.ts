// DOCVIEW (DOC-02-AC07/AC08): geometry and draw order of the continuous PDF viewer.
import { describe, expect, it, vi } from 'vitest';
import {
  attachedRange,
  canvasRatio,
  currentPageAt,
  KEEP_ATTACHED,
  layoutPages,
  MAX_CANVAS_PIXELS,
  PAGE_GAP,
  PAGE_PADDING,
  pageAt,
  RenderCache,
  renderOrder,
  scrollTopForPage,
  visiblePages,
} from '../src/lib/documents/pdf-layout';

const A4 = { width: 595, height: 842 };

describe('layoutPages', () => {
  it('stacks pages with padding and gaps, using page 1 size until a page is known', () => {
    const layout = layoutPages(3, A4, new Map([[2, { width: 842, height: 595 }]]), 0.5);
    expect(layout.tops).toEqual([
      PAGE_PADDING,
      PAGE_PADDING + 421 + PAGE_GAP,
      PAGE_PADDING + 421 + PAGE_GAP + 297 + PAGE_GAP,
    ]);
    expect(layout.heights).toEqual([421, 297, 421]);
    expect(layout.widths).toEqual([297, 421, 297]);
    expect(layout.maxWidth).toBe(421);
    expect(layout.totalHeight).toBe(PAGE_PADDING * 2 + 421 * 2 + 297 + PAGE_GAP * 2);
    expect(layoutPages(0, A4, new Map(), 1).totalHeight).toBe(0);
  });
});

describe('page lookup', () => {
  const layout = layoutPages(10, { width: 100, height: 100 }, new Map(), 1);
  const view = (scrollTop: number, clientHeight = 200) => ({
    scrollTop,
    clientHeight,
    scrollHeight: layout.totalHeight,
  });

  it('finds the page under a position, gaps belonging to the page above', () => {
    expect(pageAt(layout, 0)).toBe(1);
    expect(pageAt(layout, PAGE_PADDING + 100 + PAGE_GAP / 2)).toBe(1);
    expect(pageAt(layout, PAGE_PADDING + 100 + PAGE_GAP)).toBe(2);
    expect(pageAt(layout, 1e9)).toBe(10);
  });

  it('reports the visible range and the page under the upper quarter line', () => {
    const top3 = scrollTopForPage(layout, 3);
    expect(visiblePages(layout, view(top3))).toEqual({ first: 2, last: 4 });
    expect(currentPageAt(layout, view(top3))).toBe(3);
    // At the very end the last page is current even if it never crosses the line.
    expect(currentPageAt(layout, view(layout.totalHeight - 200))).toBe(10);
    expect(currentPageAt(layout, view(0))).toBe(1);
  });

  it('scrolls a page to the top of the viewport, clamped to the document', () => {
    expect(scrollTopForPage(layout, 1)).toBe(0);
    expect(scrollTopForPage(layout, 2)).toBe(100 + PAGE_GAP);
    expect(scrollTopForPage(layout, 99)).toBe(scrollTopForPage(layout, 10));
  });
});

describe('renderOrder', () => {
  it('draws the current page first, the rest of the visible pages, then the neighbours', () => {
    expect(renderOrder(4, 6, 5, 20)).toEqual([5, 6, 4, 7, 8, 3]);
    expect(renderOrder(1, 1, 1, 20)).toEqual([1, 2, 3]);
    expect(renderOrder(19, 20, 20, 20)).toEqual([20, 19, 18]);
  });

  it('keeps canvases attached a few pages around the visible ones', () => {
    expect(attachedRange(5, 6, 20)).toEqual([5 - KEEP_ATTACHED, 6 + KEEP_ATTACHED]);
    expect(attachedRange(1, 2, 3)).toEqual([1, 3]);
  });
});

describe('canvasRatio', () => {
  it('uses the device pixel ratio unless the canvas would get too large', () => {
    expect(canvasRatio(600, 800, 2)).toBe(2);
    expect(canvasRatio(600, 800, 0)).toBe(1);
    const capped = canvasRatio(3000, 4000, 3);
    expect(3000 * 4000 * capped * capped).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1);
  });
});

describe('RenderCache', () => {
  it('returns a page only at the scale it was drawn at, evicting least recently used', () => {
    const release = vi.fn();
    const cache = new RenderCache<string>(2, release);
    const none = () => false;
    cache.set(1, 1, 'p1', none);
    cache.set(2, 1, 'p2', none);
    expect(cache.get(1, 1)).toBe('p1'); // 1 is now the most recent
    expect(cache.get(1, 2)).toBeUndefined();
    cache.set(3, 1, 'p3', none);
    expect(release).toHaveBeenCalledWith('p2');
    expect(cache.peek(2)).toBeUndefined();
    expect(cache.peek(1)).toBe('p1');
  });

  it('never evicts pages on screen and releases a replaced drawing', () => {
    const release = vi.fn();
    const cache = new RenderCache<string>(1, release);
    cache.set(1, 1, 'p1', () => false);
    cache.set(2, 1, 'p2', (page) => page === 1);
    expect(release).not.toHaveBeenCalled();
    expect(cache.size).toBe(2);
    cache.set(2, 2, 'p2-zoomed', (page) => page === 1);
    expect(release).toHaveBeenCalledWith('p2');
    cache.clear();
    expect(release).toHaveBeenCalledWith('p1');
    expect(release).toHaveBeenCalledWith('p2-zoomed');
    expect(cache.size).toBe(0);
  });
});
