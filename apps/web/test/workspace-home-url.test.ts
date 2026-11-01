// UX3c workspace home URL state: open dialogs (`?panel=`, repeatable in opening order), the
// redirects of the pre-UX3c section routes and the UX6 search scope onto the home.
import { describe, expect, it } from 'vitest';
import {
  isFloatingPanel,
  homeRedirect,
  legacyBankRedirect,
  legacyPanelRedirect,
  legacyQuestionsRedirect,
  legacyScopeRedirect,
  legacySearchRedirect,
  parsePanels,
  patchSearch,
  retiredPanelRedirect,
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

  it('UX7-BANK: question-create is the modal 문제 등록 editor, not a stacked side panel', () => {
    expect(parsePanels(new URLSearchParams('panel=history&panel=question-create'))).toEqual([
      'history',
      'question-create',
    ]);
    expect(withPanel('?panel=history', 'question-create', true)).toBe(
      '?panel=history&panel=question-create',
    );
    expect(isFloatingPanel('question-create')).toBe(false);
    expect(isFloatingPanel('history')).toBe(true);
  });
});

describe('home URL helpers', () => {
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

  it('UX7-DOCS: the retired 문제 PDF 관리 panel opens 문서 관리, keeping the rest of the query', () => {
    expect(parsePanels({ panel: 'question-pdfs' })).toEqual([]);
    expect(retiredPanelRedirect(WS, { panel: 'question-pdfs' })).toBe(
      `/workspaces/${WS}?panel=documents`,
    );
    expect(retiredPanelRedirect(WS, { q: 'x', panel: ['share', 'question-pdfs', 'history'] })).toBe(
      `/workspaces/${WS}?q=x&panel=share&panel=documents&panel=history`,
    );
    // 문서 관리 already open: listed once, where it first appears.
    expect(retiredPanelRedirect(WS, { panel: ['documents', 'question-pdfs'] })).toBe(
      `/workspaces/${WS}?panel=documents`,
    );
    expect(retiredPanelRedirect(WS, { panel: ['question-pdfs', 'documents'] })).toBe(
      `/workspaces/${WS}?panel=documents`,
    );
    // Nothing retired: no redirect (unknown values are just ignored by parsePanels).
    expect(retiredPanelRedirect(WS, { panel: ['documents', 'bogus'] })).toBeNull();
    expect(retiredPanelRedirect(WS, { panel: 'toString' })).toBeNull();
    expect(retiredPanelRedirect(WS, {})).toBeNull();
  });

  it('the retired 전체 문제 page (UX7-BANK) keeps only a valid ?question=', () => {
    expect(legacyBankRedirect(WS, {})).toBe(`/workspaces/${WS}`);
    expect(legacyBankRedirect(WS, { status: 'ALL', create: '1', q: 'x', chapter: DOC })).toBe(
      `/workspaces/${WS}`,
    );
    expect(legacyBankRedirect(WS, { question: [DOC, SECTION], type: 'MCQ' })).toBe(
      `/workspaces/${WS}?question=${DOC}`,
    );
    expect(legacyBankRedirect(WS, { question: '../x' })).toBe(`/workspaces/${WS}`);
  });

  it('questions keeps its whole query (filters and the open question)', () => {
    expect(
      legacyQuestionsRedirect(WS, { status: ['retry', 'correct'], q: '염소', question: 'x' }),
    ).toBe(`/workspaces/${WS}?status=retry&status=correct&q=%EC%97%BC%EC%86%8C&question=x`);
    expect(legacyQuestionsRedirect(WS, {})).toBe(`/workspaces/${WS}`);
  });

  it('search becomes a 본문 search (text=) and its chapter a section (UX7-SEARCH)', () => {
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
      text: 'water',
      mode: 'keyword',
      document: DOC,
      section: SECTION,
    });
    // A chapter without its document is meaningless.
    expect(legacySearchRedirect(WS, { chapter: SECTION })).toBe(`/workspaces/${WS}`);
  });

  it('UX6 unified-search URLs (scope=) move to the split searches (UX7-SEARCH)', () => {
    const migrate = (params: Record<string, string | string[]>) => {
      const target = legacyScopeRedirect(WS, params);
      expect(target).not.toBeNull();
      return Object.fromEntries(new URL(target ?? '', 'http://x').searchParams);
    };
    // Nothing to migrate.
    expect(legacyScopeRedirect(WS, { q: 'x', text: 'y' })).toBeNull();
    // Body only: its query is the 본문 search; other keys stay, papers goes.
    expect(
      migrate({ scope: 'content', q: 'water', mode: 'keyword', papers: '1', panel: 'history' }),
    ).toEqual({ text: 'water', mode: 'keyword', panel: 'history' });
    // Questions only or both off: `q` stays the 문제 search.
    expect(migrate({ scope: 'questions', q: '염소', chapter: 'none' })).toEqual({
      q: '염소',
      chapter: 'none',
    });
    expect(migrate({ scope: 'none' })).toEqual({});
    // An explicit text wins over a body-only q.
    expect(migrate({ scope: 'content', q: 'old', text: 'new' })).toEqual({ text: 'new' });
  });

  it('applies the scope and retired-panel migrations in one redirect', () => {
    expect(homeRedirect(WS, { q: 'x', panel: 'history' })).toBeNull();
    expect(homeRedirect(WS, { panel: 'question-pdfs' })).toBe(`/workspaces/${WS}?panel=documents`);
    expect(homeRedirect(WS, { scope: 'questions', q: '염소' })).toBe(
      `/workspaces/${WS}?q=%EC%97%BC%EC%86%8C`,
    );
    const both = homeRedirect(WS, {
      scope: 'content',
      q: 'water',
      panel: ['history', 'question-pdfs'],
    });
    const url = new URL(both ?? '', 'http://x');
    expect(url.searchParams.get('text')).toBe('water');
    expect(url.searchParams.has('q') || url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.getAll('panel')).toEqual(['history', 'documents']);
  });

  it('builds home paths with or without a query', () => {
    expect(workspaceHomePath(WS)).toBe(`/workspaces/${WS}`);
    expect(workspaceHomePath(WS, 'panel=share')).toBe(`/workspaces/${WS}?panel=share`);
    expect(workspaceHomePath(WS, '?panel=share')).toBe(`/workspaces/${WS}?panel=share`);
  });
});
