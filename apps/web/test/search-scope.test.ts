// SEARCH-01-AC07 (UX6): the 문제/본문 scope checkboxes, whether each side has content, and when the
// search button is disabled (with which message) or searches one side only.
import { describe, expect, it } from 'vitest';
import {
  hasSearchableBody,
  SEARCH_BLOCK_MESSAGES,
  SEARCH_NOTICE_MESSAGES,
  searchReadiness,
} from '../src/lib/search/scope';

const both = { questions: true, body: true };
const none = { questions: false, body: false };
const onlyQuestions = { questions: true, body: false };
const onlyBody = { questions: false, body: true };

describe('searchReadiness', () => {
  it('searches both sides when both are checked and have content', () => {
    expect(searchReadiness(both, both)).toEqual({ effective: both, blocked: null, notice: null });
  });

  it('is blocked with both boxes off, whatever the content', () => {
    expect(searchReadiness(none, both).blocked).toBe('noScope');
    expect(searchReadiness(none, none).blocked).toBe('noScope');
    expect(searchReadiness(none, both).effective).toEqual(none);
  });

  it('is blocked when the workspace has neither questions nor body', () => {
    for (const checked of [both, onlyQuestions, onlyBody]) {
      expect(searchReadiness(checked, none)).toEqual({
        effective: none,
        blocked: 'nothingToSearch',
        notice: null,
      });
    }
  });

  it('is blocked when the only checked side is empty', () => {
    expect(searchReadiness(onlyQuestions, onlyBody).blocked).toBe('noQuestions');
    expect(searchReadiness(onlyBody, onlyQuestions).blocked).toBe('noBody');
  });

  it('runs one checked side alone', () => {
    expect(searchReadiness(onlyQuestions, both)).toEqual({
      effective: onlyQuestions,
      blocked: null,
      notice: null,
    });
    expect(searchReadiness(onlyBody, both)).toEqual({
      effective: onlyBody,
      blocked: null,
      notice: null,
    });
  });

  it('searches the side with content when both are checked and one is empty', () => {
    expect(searchReadiness(both, onlyQuestions)).toEqual({
      effective: onlyQuestions,
      blocked: null,
      notice: 'questionsOnly',
    });
    expect(searchReadiness(both, onlyBody)).toEqual({
      effective: onlyBody,
      blocked: null,
      notice: 'bodyOnly',
    });
  });

  it('has Korean copy for every state', () => {
    expect(SEARCH_BLOCK_MESSAGES.noScope).toBe('검색 범위를 하나 이상 선택하세요.');
    expect(SEARCH_BLOCK_MESSAGES.noQuestions).toMatch(/검색할 문제가 없습니다/);
    expect(SEARCH_BLOCK_MESSAGES.noBody).toMatch(/검색할 본문이 없습니다/);
    expect(SEARCH_BLOCK_MESSAGES.nothingToSearch).toMatch(/검색할 문제와 본문이 없습니다/);
    expect(SEARCH_NOTICE_MESSAGES.bodyOnly).toMatch(/본문만 검색/);
    expect(SEARCH_NOTICE_MESSAGES.questionsOnly).toMatch(/문제만 검색/);
  });
});

describe('hasSearchableBody', () => {
  const book = { document_type: 'book', active_revision_id: 'r1' } as const;
  const processingBook = { document_type: 'book', active_revision_id: null } as const;
  const paper = { document_type: 'question_paper', active_revision_id: 'r2' } as const;

  it('needs a published document', () => {
    expect(hasSearchableBody([], true)).toBe(false);
    expect(hasSearchableBody([processingBook], true)).toBe(false);
    expect(hasSearchableBody([book], false)).toBe(true);
  });

  it('counts question papers only while they are searched (문제 checked)', () => {
    expect(hasSearchableBody([paper], true)).toBe(true);
    expect(hasSearchableBody([paper], false)).toBe(false);
  });

  it('never blocks on a list that failed to load', () => {
    expect(hasSearchableBody([], false, true)).toBe(true);
  });
});
