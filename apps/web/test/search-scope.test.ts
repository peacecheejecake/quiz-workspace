// SEARCH-01-AC09 (UX7-SEARCH): what each of the home's two searches can search, and the 본문
// search's address-bar key.
import { describe, expect, it } from 'vitest';
import {
  addressBarContentKey,
  hasSearchableBody,
  hasSearchableQuestions,
} from '../src/lib/search/scope';

const book = { document_type: 'book' as const, active_revision_id: 'r1' };
const paper = { document_type: 'question_paper' as const, active_revision_id: 'r2' };
const processingBook = { document_type: 'book' as const, active_revision_id: null };

describe('hasSearchableBody', () => {
  it('needs a published document, a book or a question paper', () => {
    expect(hasSearchableBody([])).toBe(false);
    expect(hasSearchableBody([processingBook])).toBe(false);
    expect(hasSearchableBody([book])).toBe(true);
    expect(hasSearchableBody([paper])).toBe(true);
  });

  it('never blocks on a list that failed to load', () => {
    expect(hasSearchableBody([], true)).toBe(true);
  });
});

describe('hasSearchableQuestions', () => {
  it('blocks only when the workspace is known to have no question', () => {
    expect(hasSearchableQuestions(false)).toBe(false);
    expect(hasSearchableQuestions(true)).toBe(true);
    expect(hasSearchableQuestions(null)).toBe(true);
  });
});

describe('addressBarContentKey', () => {
  it('reads the 본문 query from `text`, never from the 문제 search `q`', () => {
    expect(addressBarContentKey({ text: 'chlorine', mode: 'keyword' })).toBe(
      'text=chlorine&mode=keyword',
    );
    expect(addressBarContentKey({ q: 'chlorine' })).toBe('');
  });

  it('searches question papers unless papers=0, and is empty without a query', () => {
    expect(addressBarContentKey({ text: 'x', papers: '1' })).toBe('text=x');
    expect(addressBarContentKey({ text: 'x', papers: '0' })).toBe('text=x&papers=0');
    expect(addressBarContentKey({ mode: 'keyword' })).toBe('');
  });
});
