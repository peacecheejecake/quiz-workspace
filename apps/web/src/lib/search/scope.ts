// SEARCH-01 search scopes (docs/screens/search.md, UX6): the unified search's two independent
// checkboxes 문제 (the heatmap) and 본문 (the content search API), whether each has anything to
// search in this workspace, and what the search button does about it. Pure, so the rules are
// unit-tested without the page.

export interface ScopeFlags {
  readonly questions: boolean;
  readonly body: boolean;
}

/** Why the search button is disabled (in priority order). */
export type SearchBlock = 'noScope' | 'nothingToSearch' | 'noQuestions' | 'noBody';

/** A search that runs on one side only although both are checked (the other is empty). */
export type SearchNotice = 'questionsOnly' | 'bodyOnly';

export interface SearchReadiness {
  /** What a search actually runs on: the checked scopes that have something to search. */
  readonly effective: ScopeFlags;
  readonly blocked: SearchBlock | null;
  readonly notice: SearchNotice | null;
}

export const SEARCH_BLOCK_MESSAGES: Readonly<Record<SearchBlock, string>> = {
  noScope: '검색 범위를 하나 이상 선택하세요.',
  nothingToSearch: '검색할 문제와 본문이 없습니다. 문서나 문제를 먼저 등록하세요.',
  noQuestions: '검색할 문제가 없습니다. 문제를 먼저 등록하세요.',
  noBody: '검색할 본문이 없습니다. 문서를 먼저 등록하고 발행하세요.',
};

export const SEARCH_NOTICE_MESSAGES: Readonly<Record<SearchNotice, string>> = {
  questionsOnly: '검색할 본문이 없어 문제만 검색합니다.',
  bodyOnly: '등록된 문제가 없어 본문만 검색합니다.',
};

/**
 * The search button's state for the `checked` scopes, given which scopes have content
 * (`available`). Both off, or nothing to search on any checked side, disables it; both checked
 * with one side empty searches the other side only.
 */
export function searchReadiness(checked: ScopeFlags, available: ScopeFlags): SearchReadiness {
  const effective = {
    questions: checked.questions && available.questions,
    body: checked.body && available.body,
  };
  let blocked: SearchBlock | null = null;
  if (!checked.questions && !checked.body) blocked = 'noScope';
  else if (!available.questions && !available.body) blocked = 'nothingToSearch';
  else if (!effective.questions && !effective.body) {
    blocked = checked.questions ? 'noQuestions' : 'noBody';
  }
  let notice: SearchNotice | null = null;
  if (!blocked && checked.questions && checked.body) {
    if (!effective.body) notice = 'questionsOnly';
    else if (!effective.questions) notice = 'bodyOnly';
  }
  return { effective, blocked, notice };
}

export interface BodyDocument {
  readonly document_type?: 'book' | 'question_paper' | null;
  readonly active_revision_id?: string | null;
}

/**
 * Whether the 본문 search has a published document to search: a book, or a question paper when
 * question papers are searched too (문제 checked, UX4). An unknown list (failed to load) counts as
 * searchable so a load failure never blocks the search.
 */
export function hasSearchableBody(
  documents: readonly BodyDocument[],
  includeQuestionPapers: boolean,
  listFailed = false,
): boolean {
  if (listFailed) return true;
  return documents.some(
    (d) =>
      d.active_revision_id != null &&
      (d.document_type !== 'question_paper' || includeQuestionPapers),
  );
}
