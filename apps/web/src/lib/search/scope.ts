// SEARCH-01 what each of the home's two searches can search (docs/screens/search.md, UX7-SEARCH):
// the 문제 search needs a confirmed question, the 본문 search a published document. Pure, so the
// rules are unit-tested without the page. (UX6's scope checkboxes are gone: SEARCH-01-AC07 retired.)
import { parseSearchParams, searchParamsFor } from './state';

export interface BodyDocument {
  readonly document_type?: 'book' | 'question_paper' | null;
  readonly active_revision_id?: string | null;
}

/**
 * Whether the 본문 search has a published document to search (a book or a question paper: both
 * are searched, UX7-SEARCH). An unknown list (failed to load) counts as searchable so a load
 * failure never blocks the search.
 */
export function hasSearchableBody(documents: readonly BodyDocument[], listFailed = false): boolean {
  if (listFailed) return true;
  return documents.some((d) => d.active_revision_id != null);
}

/** Whether the 문제 search has something to search; unknown (null) never blocks. */
export function hasSearchableQuestions(hasQuestions: boolean | null): boolean {
  return hasQuestions !== false;
}

/** The address bar's 본문 search as a stable key ('' = none). */
export function addressBarContentKey(
  params: Readonly<Record<string, string | string[] | undefined>>,
): string {
  const q = parseSearchParams(params);
  if (!q.query) return '';
  return searchParamsFor(q);
}
