// UX3c workspace home URL state: open dialogs (`?panel=`, repeatable in opening order), the
// redirects of the pre-UX3c section routes and the UX6 search scope onto the home.
import { describe, expect, it } from 'vitest';
import {
  exclusiveClose,
  isFloatingPanel,
  homeRedirect,
  legacyBankRedirect,
  legacyGenerateRedirect,
  legacyPanelRedirect,
  legacyQuestionsRedirect,
  legacyScopeRedirect,
  legacySearchRedirect,
  parsePanels,
  patchSearch,
  retiredPanelRedirect,
  withPanel,
  withPracticeQuestion,
  withRunPanel,
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

  it('MOCK-01-AC01 the retired 문제 생성 panel opens 모의고사, keeping the rest of the query (QGEN-RM)', () => {
    expect(parsePanels({ panel: 'generate' })).toEqual([]);
    expect(retiredPanelRedirect(WS, { panel: 'generate' })).toBe(
      `/workspaces/${WS}?panel=mock-exams`,
    );
    expect(retiredPanelRedirect(WS, { q: 'x', panel: ['documents', 'generate'] })).toBe(
      `/workspaces/${WS}?q=x&panel=documents&panel=mock-exams`,
    );
    expect(retiredPanelRedirect(WS, { panel: ['mock-exams', 'generate'] })).toBe(
      `/workspaces/${WS}?panel=mock-exams`,
    );
    expect(homeRedirect(WS, { panel: ['generate', 'question-pdfs'] })).toBe(
      `/workspaces/${WS}?panel=mock-exams&panel=documents`,
    );
  });

  it('the retired 변형 출제 pages (QGEN-RM) open the 모의고사 dialog on the home', () => {
    expect(legacyGenerateRedirect(WS)).toBe(`/workspaces/${WS}?panel=mock-exams`);
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

// QVIEW-01-AC09 (user decision 2026-11-02): the practice panel (`?question=`) and the range run
// panel (`?practice=`) are never open together; opening one closes the other.
describe('the practice panel and the range run panel are exclusive', () => {
  const RUN = '44444444-4444-4444-8444-444444444444';
  const Q = '66666666-6666-4666-8666-666666666666';

  it('opening a question drops the run, opening a run drops the question', () => {
    expect(withPracticeQuestion(`?q=x&practice=${RUN}&i=2&panel=history`, Q)).toBe(
      `?q=x&panel=history&question=${Q}`,
    );
    expect(withPracticeQuestion('?status=retry', Q)).toBe(`?status=retry&question=${Q}`);
    expect(
      withRunPanel(`?q=x&question=${Q}&panel=history`, {
        step: 'picker',
        source: 'bank',
        mockExamId: null,
      }),
    ).toBe('?q=x&panel=history&practice=new&source=bank');
    expect(withRunPanel('?q=x', { step: 'solve', runId: RUN, position: 3 })).toBe(
      `?q=x&practice=${RUN}&i=3`,
    );
  });

  it('names the address with the other panel closed when an open replaces it', () => {
    // Opening the run over the practice panel closes the practice panel first.
    expect(
      exclusiveClose(`?panel=history&question=${Q}`, '?panel=history&practice=new&source=bank'),
    ).toBe('?panel=history');
    // Opening a question over the run closes the run first.
    expect(exclusiveClose(`?q=x&practice=${RUN}&i=2`, `?q=x&question=${Q}`)).toBe('?q=x');
    // Nothing to close: another question, a position of the run, a plain dialog.
    expect(exclusiveClose(`?question=${Q}`, '?question=other')).toBeNull();
    expect(exclusiveClose(`?practice=${RUN}&i=1`, `?practice=${RUN}&i=2`)).toBeNull();
    expect(exclusiveClose('?panel=history', `?panel=history&question=${Q}`)).toBeNull();
    expect(exclusiveClose('', '?practice=new&source=bank')).toBeNull();
  });

  it('a deep link with both keeps the run (the later intent) and drops the question', () => {
    expect(homeRedirect(WS, { question: Q, practice: RUN, i: '2', q: 'x' })).toBe(
      `/workspaces/${WS}?practice=${RUN}&i=2&q=x`,
    );
    expect(homeRedirect(WS, { question: Q, practice: 'new', source: 'bank' })).toBe(
      `/workspaces/${WS}?practice=new&source=bank`,
    );
    // Combined with a retired panel value: one redirect.
    const url = new URL(
      homeRedirect(WS, { question: Q, practice: RUN, panel: 'question-pdfs' }) ?? '',
      'http://x',
    );
    expect(url.searchParams.has('question')).toBe(false);
    expect(url.searchParams.get('practice')).toBe(RUN);
    expect(url.searchParams.getAll('panel')).toEqual(['documents']);
    expect(homeRedirect(WS, { question: Q })).toBeNull();
    expect(homeRedirect(WS, { practice: RUN })).toBeNull();
  });
});
