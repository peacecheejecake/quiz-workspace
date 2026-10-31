// QIMP-REVIEW-SCALE: paging of the QIMPORT-01 draft review.
import { describe, expect, it } from 'vitest';
import {
  clampDraftPage,
  DRAFT_PAGE_SIZE,
  draftPageCount,
  draftPageOf,
  draftPageRange,
  pagerItems,
} from '../src/lib/questions/draft-pages';

describe('draft pages', () => {
  it('counts pages, at least one even without drafts', () => {
    expect(DRAFT_PAGE_SIZE).toBe(100);
    expect(draftPageCount(0)).toBe(1);
    expect(draftPageCount(100)).toBe(1);
    expect(draftPageCount(101)).toBe(2);
    expect(draftPageCount(752)).toBe(8);
    expect(draftPageCount(1000)).toBe(10);
  });

  it('keeps the page within the drafts and slices at most one page', () => {
    expect(clampDraftPage(9, 752)).toBe(7);
    expect(clampDraftPage(-1, 752)).toBe(0);
    expect(clampDraftPage(Number.NaN, 752)).toBe(0);
    expect(draftPageRange(0, 752)).toEqual({ start: 0, end: 100 });
    expect(draftPageRange(7, 752)).toEqual({ start: 700, end: 752 });
    expect(draftPageRange(20, 752)).toEqual({ start: 700, end: 752 });
    expect(draftPageRange(0, 0)).toEqual({ start: 0, end: 0 });
    for (const total of [1, 99, 100, 101, 750, 1000, 5000]) {
      for (let p = 0; p < draftPageCount(total); p++) {
        const { start, end } = draftPageRange(p, total);
        expect(end - start).toBeLessThanOrEqual(DRAFT_PAGE_SIZE);
        expect(end - start).toBeGreaterThan(0);
      }
    }
    expect(draftPageOf(0)).toBe(0);
    expect(draftPageOf(99)).toBe(0);
    expect(draftPageOf(100)).toBe(1);
  });

  it('lists every page up to 7, otherwise the ends and the current page with its neighbours', () => {
    expect(pagerItems(0, 1)).toEqual([0]);
    expect(pagerItems(3, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(pagerItems(0, 10)).toEqual([0, 1, 2, 3, 'gap', 9]);
    expect(pagerItems(5, 10)).toEqual([0, 'gap', 4, 5, 6, 'gap', 9]);
    expect(pagerItems(9, 10)).toEqual([0, 'gap', 6, 7, 8, 9]);
    for (let count = 1; count <= 60; count++) {
      for (let current = 0; current < count; current++) {
        const items = pagerItems(current, count);
        const pages = items.filter((i): i is number => i !== 'gap');
        expect(pages).toContain(current);
        expect(pages[0]).toBe(0);
        expect(pages.at(-1)).toBe(count - 1);
        expect(items.length).toBeLessThanOrEqual(7);
        expect([...pages].sort((a, b) => a - b)).toEqual(pages);
      }
    }
  });
});
