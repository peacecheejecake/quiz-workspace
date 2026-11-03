// UX3c workspace home URL state: open dialogs (`?panel=`, repeatable in opening order), the
// redirects of the pre-UX3c section routes and the UX6 search scope onto the home.
import { describe, expect, it } from 'vitest';
import {
  contentSearchRedirect,
  askConversationOf,
  closeDialog,
  exclusiveClose,
  holdsPracticePanels,
  openDialogs,
  withAskConversation,
  withoutAsk,
  withoutPanels,
  isFloatingPanel,
  isLegacySearchUrl,
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

  it('the old search URL becomes the search page with text= and section= (SEARCH-02-AC03)', () => {
    expect(isLegacySearchUrl({ q: 'water' })).toBe(true);
    expect(isLegacySearchUrl({ text: 'water', section: SECTION })).toBe(false);
    const target = legacySearchRedirect(WS, {
      q: 'water',
      mode: 'keyword',
      document: DOC,
      chapter: SECTION,
      papers: '1',
      other: 'dropped',
    });
    const url = new URL(target, 'http://x');
    expect(url.pathname).toBe(`/workspaces/${WS}/search`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      text: 'water',
      mode: 'keyword',
      document: DOC,
      section: SECTION,
    });
    // A chapter alone stays a chapter filter (the API takes chapter_ids without document_ids).
    expect(legacySearchRedirect(WS, { q: '주의', chapter: SECTION })).toBe(
      `/workspaces/${WS}/search?text=%EC%A3%BC%EC%9D%98&section=${SECTION}`,
    );
    expect(legacySearchRedirect(WS, { q: '' })).toBe(`/workspaces/${WS}/search`);
  });

  it('a home 본문 search (text=) moves to the search page with its search keys only (SEARCH-02-AC03)', () => {
    const page = (target: string | null) => {
      const url = new URL(target ?? '', 'http://x');
      expect(url.pathname).toBe(`/workspaces/${WS}/search`);
      return Object.fromEntries(url.searchParams);
    };
    expect(contentSearchRedirect(WS, { q: 'x', panel: 'history' })).toBeNull();
    expect(contentSearchRedirect(WS, { text: '  ' })).toBeNull();
    expect(
      page(
        contentSearchRedirect(WS, {
          text: '주의',
          mode: 'keyword',
          q: '개요',
          panel: 'history',
          question: 'x',
          status: 'retry',
        }),
      ),
    ).toEqual({ text: '주의', mode: 'keyword' });
    expect(page(contentSearchRedirect(WS, { text: 'w', document: DOC, section: SECTION }))).toEqual(
      { text: 'w', document: DOC, section: SECTION },
    );
    // An open 문서 요약 panel owns `document`/`section`: not the search's.
    expect(
      page(contentSearchRedirect(WS, { text: 'w', panel: 'document-summary', document: DOC })),
    ).toEqual({ text: 'w' });
    // Through homeRedirect, after the UX6 scope migration.
    expect(page(homeRedirect(WS, { scope: 'content', q: '주의' }))).toEqual({ text: '주의' });
    expect(page(homeRedirect(WS, { text: '주의', mode: 'keyword', q: '개요' }))).toEqual({
      text: '주의',
      mode: 'keyword',
    });
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
      scope: 'questions',
      q: 'water',
      panel: ['history', 'question-pdfs'],
    });
    const url = new URL(both ?? '', 'http://x');
    expect(url.searchParams.get('q')).toBe('water');
    expect(url.searchParams.has('scope')).toBe(false);
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

// ASK-01 (ASK-SYNC 2026-11-02 "panel 쌓기·뒤로가기"): `?panel=ask[&conversation=<id>]` is a home
// dialog like the others, and it lives beside the practice panel and the run panel (QVIEW-01-AC09
// does not concern it).
describe('the AI 질문 panel in the URL', () => {
  const C = '77777777-7777-4777-8777-777777777777';
  const RUN = '44444444-4444-4444-8444-444444444444';
  const Q = '66666666-6666-4666-8666-666666666666';

  it('opens on the list or a conversation, on top, and closes with its conversation', () => {
    expect(withAskConversation('?q=x&panel=history', null)).toBe('?q=x&panel=history&panel=ask');
    expect(withAskConversation('?panel=ask&panel=history', C)).toBe(
      `?panel=history&panel=ask&conversation=${C}`,
    );
    expect(withAskConversation(`?panel=ask&conversation=${C}`, null)).toBe('?panel=ask');
    expect(withoutAsk(`?q=x&panel=ask&conversation=${C}&panel=history`)).toBe('?q=x&panel=history');
    expect(closeDialog(`?panel=ask&conversation=${C}`, 'ask')).toBe('');
    expect(withoutPanels(`?q=x&panel=ask&conversation=${C}`)).toBe('?q=x');
  });

  it('reads the conversation only while the panel is open, and only a uuid', () => {
    expect(askConversationOf(new URLSearchParams(`panel=ask&conversation=${C}`))).toBe(C);
    expect(askConversationOf(new URLSearchParams('panel=ask&conversation=nope'))).toBeNull();
    expect(askConversationOf(new URLSearchParams('panel=ask'))).toBeNull();
    expect(askConversationOf(new URLSearchParams(`conversation=${C}`))).toBeUndefined();
  });

  it('stays open beside the practice panel and the run panel, whichever opens or closes', () => {
    const withAsk = `?panel=ask&conversation=${C}`;
    expect(openDialogs(`${withAsk}&question=${Q}`)).toEqual(['question', 'ask']);
    expect(withPracticeQuestion(`${withAsk}&practice=${RUN}&i=2`, Q)).toBe(
      `${withAsk}&question=${Q}`,
    );
    expect(
      withRunPanel(`${withAsk}&question=${Q}`, {
        step: 'picker',
        source: 'bank',
        mockExamId: null,
      }),
    ).toBe(`${withAsk}&practice=new&source=bank`);
    // Swapping the practice panel for the run closes only the practice panel.
    expect(exclusiveClose(`${withAsk}&question=${Q}`, `${withAsk}&practice=new&source=bank`)).toBe(
      withAsk,
    );
    expect(closeDialog(`${withAsk}&question=${Q}`, 'question')).toBe(withAsk);
    // A deep link with both panels keeps the run and the AI 질문 panel.
    const url = new URL(
      homeRedirect(WS, { panel: 'ask', conversation: C, question: Q, practice: RUN, i: '1' }) ?? '',
      'http://x',
    );
    expect(url.searchParams.getAll('panel')).toEqual(['ask']);
    expect(url.searchParams.get('conversation')).toBe(C);
    expect(url.searchParams.get('practice')).toBe(RUN);
    expect(url.searchParams.has('question')).toBe(false);
  });
});

describe('holdsPracticePanels (ASK-01 deep link staging)', () => {
  const dialogs = ['documents', 'question', 'ask'];
  it('holds the practice panel until its own position is staged', () => {
    expect(holdsPracticePanels(dialogs, new Set())).toBe(true);
    expect(holdsPracticePanels(dialogs, new Set(['documents']))).toBe(true);
  });
  it('releases it before the later ask dialog is staged', () => {
    expect(holdsPracticePanels(dialogs, new Set(['documents', 'question']))).toBe(false);
  });
  it('holds the run panel at its own position too and ignores a missing panel', () => {
    expect(holdsPracticePanels(['practice', 'ask'], new Set())).toBe(true);
    expect(holdsPracticePanels(['practice', 'ask'], new Set(['practice']))).toBe(false);
    expect(holdsPracticePanels(['documents', 'ask'], new Set())).toBe(false);
  });
});
