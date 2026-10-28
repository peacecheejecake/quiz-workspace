// UX3c workspace home URL state: open dialogs (`?panel=`, repeatable in opening order), the unified
// search scope and the redirects of the pre-UX3c section routes onto the home.
import { describe, expect, it } from 'vitest';
import {
  legacyPanelRedirect,
  legacyQuestionsRedirect,
  legacySearchRedirect,
  parsePanels,
  parseScope,
  patchSearch,
  scopeIncludesContent,
  scopeIncludesQuestions,
  scopeOf,
  withPanel,
  workspaceHomePath,
} from '../src/lib/workspaces/home';

const WS = '55555555-5555-4555-8555-555555555555';
const DOC = '11111111-1111-4111-8111-111111111111';
const SECTION = '33333333-3333-4333-8333-333333333333';

describe('home dialogs in the URL', () => {
  it('parses known panels in opening order without duplicates', () => {
    expect(parsePanels(new URLSearchParams('panel=history&panel=bogus&panel=share'))).toEqual([
      'history',
      'share',
    ]);
    expect(parsePanels({ panel: ['documents', 'documents'] })).toEqual(['documents']);
    expect(parsePanels({})).toEqual([]);
  });

  it('opens a panel on top (last) and closes it, keeping other keys', () => {
    expect(withPanel('?q=x&panel=documents', 'history', true)).toBe(
      '?q=x&panel=documents&panel=history',
    );
    // Re-opening moves it to the end (on top).
    expect(withPanel('?panel=documents&panel=history', 'documents', true)).toBe(
      '?panel=history&panel=documents',
    );
    expect(withPanel('?panel=documents&question=abc', 'documents', false)).toBe('?question=abc');
    expect(withPanel('', 'share', false)).toBe('');
  });
});

describe('unified search scope', () => {
  it('defaults to both and parses one-sided scopes', () => {
    expect(parseScope({})).toBe('all');
    expect(parseScope({ scope: 'bogus' })).toBe('all');
    expect(parseScope({ scope: 'questions' })).toBe('questions');
    expect(parseScope(new URLSearchParams('scope=content'))).toBe('content');
    expect(parseScope({ scope: 'none' })).toBe('none');
  });

  it('maps the two checkboxes onto a scope and back', () => {
    expect(scopeOf(true, true)).toBe('all');
    expect(scopeOf(true, false)).toBe('questions');
    expect(scopeOf(false, true)).toBe('content');
    // UX6: both boxes can be off (the search button is then disabled).
    expect(scopeOf(false, false)).toBe('none');
    expect(scopeIncludesQuestions('none') || scopeIncludesContent('none')).toBe(false);
    expect(scopeIncludesQuestions('content')).toBe(false);
    expect(scopeIncludesContent('questions')).toBe(false);
    expect(scopeIncludesQuestions('all') && scopeIncludesContent('all')).toBe(true);
  });

  it('patches keys: undefined keeps, null or empty removes', () => {
    expect(patchSearch('?a=1&b=2', { a: undefined, b: null, c: '3' })).toBe('?a=1&c=3');
    expect(patchSearch('?q=x', { q: '' })).toBe('');
  });
});

describe('pre-UX3c routes redirect onto the home', () => {
  it('documents, history and sharing open their dialog', () => {
    expect(legacyPanelRedirect(WS, 'documents')).toBe(`/workspaces/${WS}?panel=documents`);
    expect(legacyPanelRedirect(WS, 'history')).toBe(`/workspaces/${WS}?panel=history`);
    expect(legacyPanelRedirect(WS, 'share')).toBe(`/workspaces/${WS}?panel=share`);
  });

  it('questions keeps its whole query (filters and the open question)', () => {
    expect(
      legacyQuestionsRedirect(WS, { status: ['retry', 'correct'], q: '염소', question: 'x' }),
    ).toBe(`/workspaces/${WS}?status=retry&status=correct&q=%EC%97%BC%EC%86%8C&question=x`);
    expect(legacyQuestionsRedirect(WS, {})).toBe(`/workspaces/${WS}`);
  });

  it('search becomes a content-only search and its chapter a section', () => {
    const target = legacySearchRedirect(WS, {
      q: 'water',
      mode: 'keyword',
      document: DOC,
      chapter: SECTION,
      papers: '1',
      other: 'dropped',
    });
    const url = new URL(target, 'http://x');
    expect(url.pathname).toBe(`/workspaces/${WS}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'water',
      mode: 'keyword',
      document: DOC,
      papers: '1',
      section: SECTION,
      scope: 'content',
    });
    // A chapter without its document is meaningless.
    expect(legacySearchRedirect(WS, { chapter: SECTION })).toBe(`/workspaces/${WS}?scope=content`);
  });

  it('builds home paths with or without a query', () => {
    expect(workspaceHomePath(WS)).toBe(`/workspaces/${WS}`);
    expect(workspaceHomePath(WS, 'panel=share')).toBe(`/workspaces/${WS}?panel=share`);
    expect(workspaceHomePath(WS, '?panel=share')).toBe(`/workspaces/${WS}?panel=share`);
  });
});
