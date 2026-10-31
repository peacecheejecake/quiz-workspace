// Pages of the QIMPORT-01 draft review (QIMP-REVIEW-SCALE): a real question PDF yields hundreds
// of drafts (316 pages → ~750), so the review shows them a page at a time. Only the rendering is
// paged — the drafts, the selection, `전체 선택` and every count stay over all drafts.

/** Drafts per page of the review. */
export const DRAFT_PAGE_SIZE = 100;

export function draftPageCount(total: number, size = DRAFT_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / size));
}

/** `page` (0-based) kept within the pages of `total` drafts (e.g. after the list shrank). */
export function clampDraftPage(page: number, total: number, size = DRAFT_PAGE_SIZE): number {
  const last = draftPageCount(total, size) - 1;
  return Math.min(Math.max(0, Math.trunc(page) || 0), last);
}

/** The slice `[start, end)` of the drafts on `page` (0-based, clamped). */
export function draftPageRange(
  page: number,
  total: number,
  size = DRAFT_PAGE_SIZE,
): { readonly start: number; readonly end: number } {
  const p = clampDraftPage(page, total, size);
  const start = p * size;
  return { start, end: Math.min(Math.max(0, total), start + size) };
}

/** The page (0-based) that holds the draft at `index` of the sorted list. */
export function draftPageOf(index: number, size = DRAFT_PAGE_SIZE): number {
  return Math.max(0, Math.floor(index / size));
}

export type PagerItem = number | 'gap';

/**
 * Page buttons of the pager (0-based page numbers, `'gap'` = hidden pages): every page when
 * there are at most 7, otherwise the first, the last and the current one with its neighbours,
 * so the pager keeps a small, stable width on a phone.
 */
export function pagerItems(current: number, count: number): PagerItem[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i);
  const c = Math.min(Math.max(0, current), count - 1);
  const from = Math.max(1, Math.min(c - 1, count - 4));
  const to = Math.min(count - 2, Math.max(c + 1, 3));
  const items: PagerItem[] = [0];
  if (from > 1) items.push('gap');
  for (let i = from; i <= to; i++) items.push(i);
  if (to < count - 2) items.push('gap');
  items.push(count - 1);
  return items;
}
