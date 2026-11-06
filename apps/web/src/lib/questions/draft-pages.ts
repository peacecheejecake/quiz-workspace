// Pages of the QIMPORT-01 draft review (QIMP-REVIEW-SCALE): a real question PDF yields hundreds
// of drafts (316 pages → ~750), so the review shows them a page at a time. Only the rendering is
// paged — the drafts, the selection, `전체 선택` and every count stay over all drafts.
//
// QIMP-PAGING: the screen keeps a summary of every draft (`DraftSummary`: what selecting,
// counting and registering reads, no question text or answers) and the content of the pages it
// has loaded (`GET /drafts?offset&limit`); a page whose content is not loaded yet shows a loading
// state until it arrives.
import type { Schemas } from '@quiz/api-client';
import type { DraftSummary, ReviewDraft } from './drafts';

export type ImportDraftSummary = Schemas['ImportDraftSummary'];

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

/** The screen's summary of an API draft summary (same rules as `reviewDraftFromImport`). */
export function summaryFromImport(draft: ImportDraftSummary): DraftSummary {
  return {
    id: draft.id,
    version: draft.version,
    position: draft.position,
    questionNumber: draft.question_number,
    type: draft.question_type,
    reviewStatus: draft.review_status,
    publishedQuestionId: draft.published_question_id,
    publishable: draft.publishable,
    answerMissing: draft.answer_missing,
    issues: draft.validations
      .filter((v) => v.code !== 'answer_missing')
      .map((v) => ({ code: v.code, severity: v.severity })),
    chapter: { chapter: draft.chapter_id ? { id: draft.chapter_id } : null },
    duplicateOf: draft.duplicate_of ?? null,
    previous: draft.previous ?? null,
  };
}

/** Only the summary fields of a draft (e.g. of one whose content is shown). */
export function summaryOf(draft: DraftSummary): DraftSummary {
  return {
    id: draft.id,
    version: draft.version,
    position: draft.position,
    questionNumber: draft.questionNumber,
    type: draft.type,
    reviewStatus: draft.reviewStatus,
    publishedQuestionId: draft.publishedQuestionId,
    publishable: draft.publishable,
    answerMissing: draft.answerMissing,
    issues: draft.issues,
    ...(draft.duplicateOf !== undefined ? { duplicateOf: draft.duplicateOf } : {}),
    ...(draft.previous !== undefined ? { previous: draft.previous } : {}),
    ...(draft.chapter
      ? { chapter: { chapter: draft.chapter.chapter ? { id: draft.chapter.chapter.id } : null } }
      : {}),
  };
}

/** Loaded draft contents by draft id. */
export type DraftContents = ReadonlyMap<string, ReviewDraft>;

/**
 * The drafts of `page` with their content, or null while any of them is not loaded (or was
 * loaded at another version: the content on screen is always the version that is selected and
 * registered).
 */
export function pageContent(
  summaries: readonly DraftSummary[],
  contents: DraftContents,
  page: number,
): ReviewDraft[] | null {
  const { start, end } = draftPageRange(page, summaries.length);
  const out: ReviewDraft[] = [];
  for (const summary of summaries.slice(start, end)) {
    const content = contents.get(summary.id);
    if (!content || content.version !== summary.version) return null;
    out.push(content);
  }
  return out;
}

/**
 * Adds loaded drafts: their content, and their summary in the list (a draft read later is newer:
 * its version, review state and chapter replace what the list had).
 */
export function withLoaded(
  summaries: readonly DraftSummary[],
  contents: DraftContents,
  loaded: readonly ReviewDraft[],
): { summaries: DraftSummary[]; contents: Map<string, ReviewDraft> } {
  const byId = new Map(loaded.map((d) => [d.id, d]));
  const next = new Map(contents);
  for (const d of loaded) next.set(d.id, d);
  return { summaries: summaries.map((s) => byId.get(s.id) ?? s), contents: next };
}
