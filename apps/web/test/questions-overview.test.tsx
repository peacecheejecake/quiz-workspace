// @vitest-environment jsdom
// QOV-01 screen: opening a dot puts `?question=` in the URL and opens the modal practice panel
// (which opens a practice session = the view); closing it removes the param and returns focus to
// the dot — also when the panel was opened by a deep link. Hovering never opens a session.
import './dom-setup';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@quiz/ui';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { OverviewItem, QuestionOverview } from '../src/lib/questions/overview-data';
import { EMPTY_OVERVIEW_FILTERS } from '../src/lib/questions/overview-filters';
import type { PlacedQuestion } from '../src/lib/questions/overview-placement';

const FAVORITES = { ...EMPTY_OVERVIEW_FILTERS, favorite: true };

// `useSearchParams` follows window.location like Next.js does for history.pushState.
const subscribe = (notify: () => void) => {
  window.addEventListener('popstate', notify);
  window.addEventListener('test:pushstate', notify);
  return () => {
    window.removeEventListener('popstate', notify);
    window.removeEventListener('test:pushstate', notify);
  };
};
const routerRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: routerRefresh, prefetch: vi.fn() }),
  useSearchParams: () =>
    new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search)),
}));

const openPracticeSession = vi.fn();
const setMyStateAction = vi.fn();
const lookupOverviewQuestionAction = vi.fn();
const submitPracticeAction = vi.fn();
const selfGradePracticeAction = vi.fn();
vi.mock('../src/lib/questions/practice-actions', () => ({
  resetPracticeAction: vi.fn(),
  submitPracticeAction: (...a: unknown[]) => submitPracticeAction(...a),
  selfGradePracticeAction: (...a: unknown[]) => selfGradePracticeAction(...a),
  setMyStateAction: (...a: unknown[]) => setMyStateAction(...a),
  lookupOverviewQuestionAction: (...a: unknown[]) => lookupOverviewQuestionAction(...a),
}));
vi.mock('../src/lib/questions/practice-open-client', async () => {
  const { fakePracticeOpen } = await import('./practice-open-fake');
  return {
    openQuestionPractice: fakePracticeOpen({
      open: (...a: unknown[]) => openPracticeSession(...a),
    }),
  };
});

// UX7-BANK: the question editor and delete of the panel's 문제 관리 menu (QPLAY-01-AC07/AC08).
const getQuestionAction = vi.fn();
const updateQuestionAction = vi.fn();
const deleteQuestionAction = vi.fn();
const questionEditorContextAction = vi.fn();
// UX7-BANK-2: 보관 and the 문제 상세 dialog's past revisions.
const setQuestionStatusAction = vi.fn();
const getQuestionRevisionAction = vi.fn();
vi.mock('../src/lib/questions/actions', () => ({
  getQuestionAction: (...a: unknown[]) => getQuestionAction(...a),
  setQuestionStatusAction: (...a: unknown[]) => setQuestionStatusAction(...a),
  getQuestionRevisionAction: (...a: unknown[]) => getQuestionRevisionAction(...a),
  updateQuestionAction: (...a: unknown[]) => updateQuestionAction(...a),
  deleteQuestionAction: (...a: unknown[]) => deleteQuestionAction(...a),
  createQuestionAction: vi.fn(),
  questionEditorContextAction: (...a: unknown[]) => questionEditorContextAction(...a),
}));

const { QuestionsOverview } =
  await import('../src/components/questions/overview/questions-overview');

const WS = '55555555-5555-4555-8555-555555555555';
const PATH = `/workspaces/${WS}`;
const id = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

const overview: QuestionOverview = {
  counts: { total: 3, unseen: 3, viewed: 0, incorrect: 0, correct: 0, retry: 0, favorite: 0 },
  chapters: [{ id: null, number: null, title: '챕터 없음', document_id: null, question_count: 3 }],
  items: [1, 2, 3].map((n) => ({
    question_id: id(n),
    chapter_id: null,
    question_number: n,
    question_type: 'MCQ' as const,
    status: 'unseen' as const,
    is_favorite: false,
    needs_retry: false,
    last_graded_result: null,
    is_pending_grading: false,
    preview: `문제 ${n} 미리보기`,
  })),
};

/** Question 1 was answered correctly: the only state where `다시 풀기` is offered (RETRY-01). */
const correctOverview: QuestionOverview = {
  ...overview,
  counts: { ...overview.counts, unseen: 2, correct: 1 },
  items: overview.items.map((item, i) =>
    i === 0
      ? { ...item, status: 'correct' as const, last_graded_result: 'correct' as const }
      : item,
  ),
};

function session(n: number) {
  return {
    ok: true,
    data: {
      id: '99999999-9999-4999-8999-999999999999',
      workspace_id: WS,
      question_id: id(n),
      question_revision_id: '88888888-8888-4888-8888-888888888888',
      question_type: 'MCQ',
      question_number: n,
      chapter_id: null,
      stem: `문제 ${n} 본문`,
      is_multi_answer: false,
      options: [{ id: 'o1', text: '보기 하나' }],
      displayed_option_ids: ['o1'],
      state: 'open',
      opened_at: '2026-10-17T00:00:00Z',
    },
  };
}

function only(...numbers: number[]): QuestionOverview {
  const items = overview.items.filter((i) => numbers.includes(Number(i.question_id.slice(-2))));
  return {
    ...overview,
    chapters: items.length
      ? overview.chapters.map((c) => ({ ...c, question_count: items.length }))
      : [],
    items,
  };
}

/** Question `n` placed as in the unfiltered heatmap (what the server lookups return). */
function outsidePlaced(n: number): PlacedQuestion {
  return {
    item: overview.items.find((i) => i.question_id === id(n)) as OverviewItem,
    number: String(n),
    chapterKey: 'none',
    chapterTitle: '챕터 없음',
    chapterNumber: undefined,
  };
}

function Screen({
  data = overview,
  requested = null,
  readOnly = null,
  createOpen = false,
  onCreateOpenChange,
  onQuestionsChanged,
  filters = data === overview ? EMPTY_OVERVIEW_FILTERS : FAVORITES,
}: {
  data?: QuestionOverview;
  requested?: PlacedQuestion | null;
  readOnly?: 'viewer' | 'archived' | null;
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
  onQuestionsChanged?: () => void;
  filters?: typeof EMPTY_OVERVIEW_FILTERS;
}) {
  return (
    <ToastProvider>
      <main>
        <QuestionsOverview
          workspaceId={WS}
          readOnly={readOnly}
          createOpen={createOpen}
          onCreateOpenChange={onCreateOpenChange}
          onQuestionsChanged={onQuestionsChanged}
          filters={filters}
          navigating={false}
          onResetFilters={vi.fn()}
          overview={data}
          failure={null}
          requested={requested}
        />
      </main>
    </ToastProvider>
  );
}

const realPushState = window.history.pushState.bind(window.history);

beforeEach(() => {
  openPracticeSession.mockReset();
  setMyStateAction.mockReset();
  lookupOverviewQuestionAction.mockReset();
  submitPracticeAction.mockReset();
  selfGradePracticeAction.mockReset();
  routerRefresh.mockReset();
  getQuestionAction.mockReset();
  updateQuestionAction.mockReset();
  deleteQuestionAction.mockReset();
  questionEditorContextAction.mockReset();
  setQuestionStatusAction.mockReset();
  getQuestionRevisionAction.mockReset();
  questionEditorContextAction.mockResolvedValue({ chapters: [], documents: [] });
  lookupOverviewQuestionAction.mockResolvedValue({ ok: true, data: null });
  openPracticeSession.mockImplementation((_ws: string, qid: string) =>
    Promise.resolve(session(Number(qid.slice(-2)))),
  );
  realPushState(null, '', PATH);
  window.history.pushState = (...args: Parameters<History['pushState']>) => {
    realPushState(...args);
    window.dispatchEvent(new Event('test:pushstate'));
  };
});

afterEach(() => {
  window.history.pushState = realPushState;
});

const heatmap = () => screen.getByRole('group', { name: '문제 heatmap' });
const dot = (n: number) =>
  within(heatmap()).getByRole('button', { name: new RegExp(`(?<!\\d)${n}번 문제`) });

describe('QuestionsOverview practice panel', () => {
  it('opens from a dot with ?question=, records the view and returns focus on Escape', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await user.click(dot(2));

    const panel = await screen.findByRole('dialog', { name: '2번 문제' });
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(new URLSearchParams(window.location.search).get('question')).toBe(id(2));
    await waitFor(() => expect(within(panel).getByText('문제 2 본문')).toBeInTheDocument());
    expect(openPracticeSession).toHaveBeenCalledTimes(1);
    expect(openPracticeSession.mock.calls[0]?.slice(0, 2)).toEqual([WS, id(2)]);
    // The view shows on the dot right away (the background is aria-hidden while the modal is open).
    await waitFor(() =>
      expect(document.querySelector(`[data-question-id="${id(2)}"]`)).toHaveAttribute(
        'data-status',
        'viewed',
      ),
    );

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.search).toBe('');
    expect(dot(2)).toHaveFocus();
  });

  it('a deep link opens the panel and closing it focuses that dot', async () => {
    const user = userEvent.setup();
    realPushState(null, '', `${PATH}?question=${id(3)}`);
    render(<Screen />);
    const panel = await screen.findByRole('dialog', { name: '3번 문제' });
    await user.click(within(panel).getByRole('button', { name: '패널 닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(dot(3)).toHaveFocus();
  });

  it('back/forward (popstate) closes and reopens the panel', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await user.click(dot(1));
    await screen.findByRole('dialog', { name: '1번 문제' });
    await act(async () => {
      realPushState(null, '', PATH);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => {
      realPushState(null, '', `${PATH}?question=${id(1)}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(await screen.findByRole('dialog', { name: '1번 문제' })).toBeVisible();
  });

  it('favorite in the panel header turns the dot into a star at once', async () => {
    const user = userEvent.setup();
    setMyStateAction.mockResolvedValue({
      ok: true,
      data: {
        question_id: id(1),
        status: 'viewed',
        is_favorite: true,
        needs_retry: false,
        last_graded_result: null,
      },
    });
    render(<Screen />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '1번 문제' });
    await user.click(within(panel).getByRole('button', { name: '즐겨찾기 추가' }));
    expect(within(panel).getByRole('button', { name: '즐겨찾기 해제' })).toBeInTheDocument();
    expect(setMyStateAction).toHaveBeenCalledWith(WS, id(1), { is_favorite: true }, 0);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(dot(1)).toHaveAttribute('aria-label', expect.stringMatching(/즐겨찾기/));
    expect(within(dot(1)).getByTestId('question-marker')).toHaveAttribute('data-shape', 'star');
  });

  it('hovering a dot never opens a practice session', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await user.hover(dot(1));
    await user.unhover(dot(1));
    expect(openPracticeSession).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });
});

describe('QuestionsOverview review fixes', () => {
  it('a deep link outside the filtered list opens from the server-resolved question', async () => {
    realPushState(null, '', `${PATH}?favorite=true&question=${id(2)}`);
    render(<Screen data={only(1, 3)} requested={outsidePlaced(2)} />);
    const panel = await screen.findByRole('dialog', { name: '2번 문제' });
    await waitFor(() => expect(within(panel).getByText('문제 2 본문')).toBeInTheDocument());
    expect(lookupOverviewQuestionAction).not.toHaveBeenCalled();
  });

  it('back/forward to a question outside the filters looks it up without the filters', async () => {
    lookupOverviewQuestionAction.mockResolvedValue({ ok: true, data: outsidePlaced(2) });
    render(<Screen data={only(1, 3)} />);
    await act(async () => {
      realPushState(null, '', `${PATH}?favorite=true&question=${id(2)}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(await screen.findByRole('dialog', { name: '2번 문제' })).toBeVisible();
    expect(lookupOverviewQuestionAction).toHaveBeenCalledWith(WS, id(2));
  });

  it('an unknown question id never opens the panel', async () => {
    realPushState(null, '', `${PATH}?question=${id(9)}`);
    render(<Screen />);
    await waitFor(() => expect(lookupOverviewQuestionAction).toHaveBeenCalledWith(WS, id(9)));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  async function navigateTo(search: string) {
    await act(async () => {
      realPushState(null, '', `${PATH}${search}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
  }

  it.each([
    [
      'a 5xx/network failure',
      () => Promise.resolve({ ok: false, kind: 'unavailable', message: 'x' }),
    ],
    ['a rejected request', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('a deep-link lookup retries after %s on the next navigation', async (_, fail) => {
    lookupOverviewQuestionAction.mockImplementationOnce(fail);
    lookupOverviewQuestionAction.mockResolvedValue({ ok: true, data: outsidePlaced(2) });
    render(<Screen data={only(1, 3)} />);
    await navigateTo(`?favorite=true&question=${id(2)}`);
    expect(await screen.findByText(/문제를 불러오지 못했습니다/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();

    await navigateTo('?favorite=true');
    await navigateTo(`?favorite=true&question=${id(2)}`);
    expect(await screen.findByRole('dialog', { name: '2번 문제' })).toBeVisible();
    expect(lookupOverviewQuestionAction).toHaveBeenCalledTimes(2);
  });

  it('a not-found lookup stays cached across navigations', async () => {
    lookupOverviewQuestionAction.mockResolvedValue({ ok: true, data: null });
    render(<Screen data={only(1, 3)} />);
    await navigateTo(`?question=${id(9)}`);
    await waitFor(() => expect(lookupOverviewQuestionAction).toHaveBeenCalledTimes(1));
    await navigateTo('');
    await navigateTo(`?question=${id(9)}`);
    // A 404-style answer is definitive too.
    lookupOverviewQuestionAction.mockResolvedValue({ ok: false, kind: 'notFound', message: 'x' });
    await navigateTo(`?question=${id(8)}`);
    await waitFor(() => expect(lookupOverviewQuestionAction).toHaveBeenCalledTimes(2));
    await navigateTo('');
    await navigateTo(`?question=${id(8)}`);
    await navigateTo(`?question=${id(9)}`);
    expect(lookupOverviewQuestionAction).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('focus goes to the nearest surviving dot when the opening dot left the heatmap', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Screen />);
    await user.click(dot(2));
    await screen.findByRole('dialog', { name: '2번 문제' });
    // The question leaves the (favorites) list while the panel is open.
    rerender(<Screen data={only(1, 3)} />);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(dot(3)).toHaveFocus();
  });

  it('focus goes to the 필터 button when the heatmap is empty after closing', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Screen />);
    const filter = document.createElement('button');
    filter.setAttribute('data-home-filter', '');
    document.body.append(filter);
    onTestFinished(() => filter.remove());
    await user.click(dot(1));
    await screen.findByRole('dialog', { name: '1번 문제' });
    rerender(<Screen data={only()} />);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(filter).toHaveFocus();
  });

  it('a rejected my-state request rolls the optimistic change back and reports it', async () => {
    const user = userEvent.setup();
    setMyStateAction.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<Screen />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '1번 문제' });
    await user.click(within(panel).getByRole('button', { name: '즐겨찾기 추가' }));
    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: '즐겨찾기 추가' })).toBeInTheDocument(),
    );
    expect(setMyStateAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/일시적인 오류/)).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: '패널 닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(within(dot(1)).getByTestId('question-marker')).toHaveAttribute('data-shape', 'square');
  });
});

const SESSION = '99999999-9999-4999-8999-999999999999';

function submitted(result: 'correct' | 'incorrect' | 'pending', extra: object = {}) {
  return {
    ok: true,
    data: {
      attempt_id: '77777777-7777-4777-8777-777777777777',
      practice_session_id: SESSION,
      question_revision_id: '88888888-8888-4888-8888-888888888888',
      state: result === 'pending' ? 'pending_grade' : 'graded',
      result,
      correct_option_ids: null,
      accepted_answers: null,
      explanation: null,
      rubric: null,
      ...extra,
    },
  };
}

const dotStatus = (n: number) =>
  document.querySelector(`[data-question-id="${id(n)}"]`)?.getAttribute('data-status');

describe('QuestionsOverview practice panel (QPLAY-01)', () => {
  it('previous/next move ?question= along the heatmap and stop at the ends', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await user.click(dot(1));
    let panel = await screen.findByRole('dialog', { name: '1번 문제' });
    expect(within(panel).getByRole('button', { name: '이전 문제' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(within(panel).getByRole('button', { name: '다음 문제' }));
    panel = await screen.findByRole('dialog', { name: '2번 문제' });
    expect(new URLSearchParams(window.location.search).get('question')).toBe(id(2));
    await waitFor(() => expect(openPracticeSession).toHaveBeenCalledTimes(2));
    await user.click(within(panel).getByRole('button', { name: '다음 문제' }));
    panel = await screen.findByRole('dialog', { name: '3번 문제' });
    const next = within(panel).getByRole('button', { name: '다음 문제' });
    expect(next).toHaveAttribute('aria-disabled', 'true');
    await user.click(next);
    expect(new URLSearchParams(window.location.search).get('question')).toBe(id(3));
    // Each question it stopped on opened its own session (= its own view).
    await waitFor(() => expect(openPracticeSession).toHaveBeenCalledTimes(3));

    await user.click(within(panel).getByRole('button', { name: '이전 문제' }));
    await screen.findByRole('dialog', { name: '2번 문제' });
    expect(new URLSearchParams(window.location.search).get('question')).toBe(id(2));
  });

  it('UX12-OPEN-AC08 a direct open posts at once, without the navigation pause', async () => {
    render(<Screen />);
    fireEvent.click(dot(1));
    await waitFor(() => expect(openPracticeSession).toHaveBeenCalledTimes(1), { timeout: 100 });
  });

  it('UX12-OPEN-AC08 rapid next opens only the question it stops on', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '1번 문제' });
    await waitFor(() => expect(openPracticeSession).toHaveBeenCalledTimes(1));

    // Both clicks run in one task, so no timer can fire between them.
    fireEvent.click(within(panel).getByRole('button', { name: '다음 문제' }));
    fireEvent.click(within(panel).getByRole('button', { name: '다음 문제' }));

    await screen.findByRole('dialog', { name: '3번 문제' });
    await waitFor(() => expect(openPracticeSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(dotStatus(3)).toBe('viewed'));
    expect(openPracticeSession.mock.calls.map((call) => call[1])).toEqual([id(1), id(3)]);
    expect(dotStatus(2)).not.toBe('viewed');
  });

  it('UX12-OPEN-AC08 closing during the pause opens nothing', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '1번 문제' });
    await waitFor(() => expect(openPracticeSession).toHaveBeenCalledTimes(1));

    fireEvent.click(within(panel).getByRole('button', { name: '다음 문제' }));
    fireEvent.click(within(panel).getByRole('button', { name: /닫기/ }));

    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(openPracticeSession).toHaveBeenCalledTimes(1);
    expect(dotStatus(2)).not.toBe('viewed');
  });

  it('submits the chosen option id, reveals the answer only then and refreshes on close', async () => {
    const user = userEvent.setup();
    submitPracticeAction.mockResolvedValue(
      submitted('correct', { correct_option_ids: ['o1'], explanation: '해설 본문' }),
    );
    render(<Screen />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '1번 문제' });
    const submit = within(panel).getByRole('button', { name: '제출' });
    await waitFor(() => expect(within(panel).getByRole('radio')).toBeInTheDocument());
    expect(submit).toBeDisabled();
    expect(within(panel).queryByText('해설 본문')).toBeNull();

    await user.click(within(panel).getByRole('radio', { name: '보기 하나' }));
    await user.click(submit);
    await waitFor(() => expect(within(panel).getByRole('status')).toHaveTextContent('정답입니다.'));
    expect(submitPracticeAction).toHaveBeenCalledWith(WS, SESSION, { selected_option_ids: ['o1'] });
    expect(within(panel).getByText('해설 본문')).toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: '보기 하나' })).toBeDisabled();
    expect(within(panel).queryByRole('button', { name: '제출' })).toBeNull();
    expect(dotStatus(1)).toBe('correct');

    expect(routerRefresh).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('a pending essay waits for the self-grade, which settles the dot', async () => {
    const user = userEvent.setup();
    openPracticeSession.mockImplementation((_ws: string, qid: string) => {
      const base = session(Number(qid.slice(-2)));
      return Promise.resolve({
        ...base,
        data: { ...base.data, question_type: 'ESSAY', options: [], displayed_option_ids: [] },
      });
    });
    submitPracticeAction.mockResolvedValue(submitted('pending', { rubric: '채점 기준 본문' }));
    selfGradePracticeAction.mockResolvedValue({
      ok: true,
      data: { attempt_id: 'x', practice_session_id: SESSION, result: 'incorrect' },
    });
    render(<Screen />);
    await user.click(dot(2));
    const panel = await screen.findByRole('dialog', { name: '2번 문제' });
    await user.type(await within(panel).findByRole('textbox', { name: '답안' }), '증발');
    await user.click(within(panel).getByRole('button', { name: '제출' }));

    await waitFor(() => expect(within(panel).getByRole('status')).toHaveTextContent('채점 대기'));
    expect(within(panel).getByText('채점 기준 본문')).toBeInTheDocument();
    expect(dotStatus(2)).toBe('viewed');
    await user.click(within(panel).getByRole('button', { name: '틀림' }));
    await waitFor(() => expect(within(panel).getByRole('status')).toHaveTextContent('오답'));
    expect(selfGradePracticeAction).toHaveBeenCalledWith(WS, SESSION, 'incorrect');
    expect(within(panel).queryByRole('button', { name: '맞음' })).toBeNull();
    expect(dotStatus(2)).toBe('incorrect');
  });

  it('a correct answer keeps the retry flag the user just set', async () => {
    const user = userEvent.setup();
    setMyStateAction.mockResolvedValue({
      ok: true,
      data: {
        question_id: id(1),
        status: 'retry',
        is_favorite: false,
        needs_retry: true,
        last_graded_result: 'correct',
      },
    });
    submitPracticeAction.mockResolvedValue(submitted('correct', { correct_option_ids: ['o1'] }));
    render(<Screen data={correctOverview} filters={EMPTY_OVERVIEW_FILTERS} />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '1번 문제' });
    await user.click(within(panel).getByRole('button', { name: '다시 풀기 표시' }));
    await within(panel).findByRole('button', { name: '다시 풀기 해제' });
    await user.click(await within(panel).findByRole('radio', { name: '보기 하나' }));
    await user.click(within(panel).getByRole('button', { name: '제출' }));
    await waitFor(() => expect(within(panel).getByRole('status')).toHaveTextContent('정답입니다.'));
    expect(within(panel).getByRole('button', { name: '다시 풀기 해제' })).toBeInTheDocument();
    expect(dotStatus(1)).toBe('retry');
  });

  it('a failed submit keeps the answer and reports the error', async () => {
    const user = userEvent.setup();
    submitPracticeAction.mockResolvedValue({
      ok: false,
      kind: 'unavailable',
      message: '일시적인 오류로 처리하지 못했습니다.',
    });
    render(<Screen />);
    await user.click(dot(3));
    const panel = await screen.findByRole('dialog', { name: '3번 문제' });
    await user.click(await within(panel).findByRole('radio', { name: '보기 하나' }));
    await user.click(within(panel).getByRole('button', { name: '제출' }));
    await waitFor(() => expect(within(panel).getByRole('alert')).toHaveTextContent('일시적인'));
    expect(within(panel).getByRole('radio', { name: '보기 하나' })).toBeChecked();
    expect(within(panel).getByRole('button', { name: '제출' })).toBeEnabled();
  });
});

describe('UX7-QDISPLAY practice panel display (QPLAY-01-AC12/AC13)', () => {
  function twoOptions(stem: string, multi = false) {
    openPracticeSession.mockImplementation((_ws: string, qid: string) => {
      const base = session(Number(qid.slice(-2)));
      return Promise.resolve({
        ...base,
        data: {
          ...base.data,
          stem,
          is_multi_answer: multi,
          options: [
            { id: 'o1', text: '보기 하나' },
            { id: 'o2', text: '보기 둘' },
            { id: 'o3', text: '보기 셋' },
          ],
          displayed_option_ids: ['o1', 'o2', 'o3'],
        },
      });
    });
  }
  /** The kit option row of a radio/checkbox (its parent element). */
  const row = (control: HTMLElement) => control.parentElement as HTMLElement;

  it('hides the 보기 label and the trailing answer mark; a wrong answer marks the choice and the correct option', async () => {
    const user = userEvent.setup();
    twoOptions('빈칸 ( )에 들어갈 말은? ( )');
    submitPracticeAction.mockResolvedValue(submitted('incorrect', { correct_option_ids: ['o2'] }));
    render(<Screen />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '1번 문제' });
    const group = await within(panel).findByRole('radiogroup', { name: '보기' });
    expect(within(panel).getByText('보기')).toHaveClass('qz-visually-hidden');
    expect(within(panel).getByText('빈칸 ( )에 들어갈 말은?')).toBeInTheDocument();
    const radios = within(group).getAllByRole('radio');
    // Before grading every row has the plain (transparent-bordered) row class only.
    const plain = row(radios[0] as HTMLElement).className;
    for (const r of radios) expect(row(r).className).toBe(plain);

    await user.click(within(panel).getByRole('radio', { name: '보기 하나' }));
    await user.click(within(panel).getByRole('button', { name: '제출' }));
    await waitFor(() => expect(within(panel).getByRole('status')).toHaveTextContent('오답입니다.'));
    const chosen = within(panel).getByRole('radio', { name: '보기 하나' });
    const answer = within(panel).getByRole('radio', { name: '보기 둘' });
    const other = within(panel).getByRole('radio', { name: '보기 셋' });
    expect(chosen).toHaveAccessibleDescription('내 선택');
    expect(answer).toHaveAccessibleDescription('정답');
    expect(other).toHaveAccessibleDescription('');
    expect(row(chosen).className).toMatch(/toneChosen/);
    expect(row(answer).className).toMatch(/toneAnswer/);
    expect(row(other).className).toBe(plain);
  });

  it('a correct answer marks only the chosen option; multi answer keeps a hidden 보기 in its name', async () => {
    const user = userEvent.setup();
    twoOptions('옳은 것을 모두 고르시오. （ ）', true);
    submitPracticeAction.mockResolvedValue(submitted('correct', { correct_option_ids: ['o3'] }));
    render(<Screen />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '1번 문제' });
    await within(panel).findAllByRole('checkbox');
    expect(within(panel).getByRole('group')).toHaveAccessibleName('보기 — 정답을 모두 고르세요');
    expect(within(panel).getByText('옳은 것을 모두 고르시오.')).toBeInTheDocument();
    await user.click(within(panel).getByRole('checkbox', { name: '보기 셋' }));
    await user.click(within(panel).getByRole('button', { name: '제출' }));
    await waitFor(() => expect(within(panel).getByRole('status')).toHaveTextContent('정답입니다.'));
    const picked = within(panel).getByRole('checkbox', { name: '보기 셋' });
    expect(picked).toHaveAccessibleDescription('정답 · 내 선택');
    expect(row(picked).className).toMatch(/toneCorrect/);
    for (const name of ['보기 하나', '보기 둘']) {
      const box = within(panel).getByRole('checkbox', { name });
      expect(box).toHaveAccessibleDescription('');
      expect(row(box).className).not.toMatch(/tone/);
    }
  });
});

describe('QuestionsOverview practice panel review fixes (M5.5)', () => {
  const dotLabel = (n: number) =>
    document.querySelector(`[data-question-id="${id(n)}"]`)?.getAttribute('aria-label') ?? '';

  function essaySessions() {
    openPracticeSession.mockImplementation((_ws: string, qid: string) => {
      const base = session(Number(qid.slice(-2)));
      return Promise.resolve({
        ...base,
        data: { ...base.data, question_type: 'ESSAY', options: [], displayed_option_ids: [] },
      });
    });
  }

  function myState(n: number, extra: object) {
    return {
      ok: true,
      data: {
        question_id: id(n),
        status: 'viewed',
        is_favorite: true,
        needs_retry: false,
        last_graded_result: null,
        ...extra,
      },
    };
  }

  it('closing the panel with browser Back refreshes the changed overview', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await user.click(dot(1));
    await screen.findByRole('dialog', { name: '1번 문제' });
    await waitFor(() => expect(dotStatus(1)).toBe('viewed'));
    expect(routerRefresh).not.toHaveBeenCalled();
    await act(async () => {
      realPushState(null, '', PATH);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('the close button refreshes too, but previous/next do not', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '1번 문제' });
    await user.click(within(panel).getByRole('button', { name: '다음 문제' }));
    const second = await screen.findByRole('dialog', { name: '2번 문제' });
    expect(routerRefresh).not.toHaveBeenCalled();
    await user.click(within(second).getByRole('button', { name: '패널 닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('a favorite toggled after an essay submit keeps the pending-grading marker', async () => {
    const user = userEvent.setup();
    essaySessions();
    submitPracticeAction.mockResolvedValue(submitted('pending'));
    setMyStateAction.mockResolvedValue(myState(2, {}));
    render(<Screen />);
    await user.click(dot(2));
    const panel = await screen.findByRole('dialog', { name: '2번 문제' });
    await user.type(await within(panel).findByRole('textbox', { name: '답안' }), '증발');
    await user.click(within(panel).getByRole('button', { name: '제출' }));
    await waitFor(() => expect(dotLabel(2)).toMatch(/채점 대기/));

    await user.click(within(panel).getByRole('button', { name: '즐겨찾기 추가' }));
    await within(panel).findByRole('button', { name: '즐겨찾기 해제' });
    expect(dotLabel(2)).toMatch(/채점 대기/);
    expect(dotStatus(2)).toBe('viewed');
  });

  it('a self-grade made while a flag change is in flight survives the flag response', async () => {
    const user = userEvent.setup();
    essaySessions();
    submitPracticeAction.mockResolvedValue(submitted('pending'));
    selfGradePracticeAction.mockResolvedValue({
      ok: true,
      data: { attempt_id: 'x', practice_session_id: SESSION, result: 'correct' },
    });
    let answer: (value: unknown) => void = () => undefined;
    setMyStateAction.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<Screen />);
    await user.click(dot(3));
    const panel = await screen.findByRole('dialog', { name: '3번 문제' });
    await user.type(await within(panel).findByRole('textbox', { name: '답안' }), '증발');
    await user.click(within(panel).getByRole('button', { name: '제출' }));
    await waitFor(() => expect(dotLabel(3)).toMatch(/채점 대기/));

    await user.click(within(panel).getByRole('button', { name: '즐겨찾기 추가' }));
    await user.click(within(panel).getByRole('button', { name: '맞음' }));
    await waitFor(() => expect(dotStatus(3)).toBe('correct'));
    // The my-state response was computed before the self-grade.
    await act(async () => answer(myState(3, { last_graded_result: null })));
    await within(panel).findByRole('button', { name: '즐겨찾기 해제' });
    expect(dotStatus(3)).toBe('correct');
    expect(dotLabel(3)).not.toMatch(/채점 대기/);
  });
});

function fullQuestion(n: number, stem = `문제 ${n} 본문`) {
  return {
    id: id(n),
    workspace_id: WS,
    question_type: 'MCQ',
    publication_status: 'CONFIRMED',
    origin: 'manual',
    chapter_id: null,
    chapter: null,
    question_number: n,
    revision: {
      id: '88888888-8888-4888-8888-888888888888',
      version: 1,
      stem,
      options: [
        { id: 'o1', text: '보기 하나' },
        { id: 'o2', text: '보기 둘' },
      ],
      correct_option_ids: ['o1'],
      accepted_answers: null,
      is_multi_answer: false,
      explanation: '해설',
      rubric: null,
      created_at: '2026-10-17T00:00:00Z',
    },
    sources: [],
    revisions: [],
    created_at: '2026-10-17T00:00:00Z',
    updated_at: '2026-10-17T00:00:00Z',
  };
}

describe('UX7-BANK 문제 관리 in the practice panel', { timeout: 20_000 }, () => {
  it('QPLAY-01-AC07 편집 reads the full question only when chosen, saves and practises the new revision', async () => {
    const user = userEvent.setup();
    getQuestionAction.mockResolvedValue({ ok: true, data: fullQuestion(2) });
    updateQuestionAction.mockResolvedValue({ ok: true, data: fullQuestion(2, '고친 본문') });
    render(<Screen />);
    await user.click(dot(2));
    const panel = await screen.findByRole('dialog', { name: '2번 문제' });
    await waitFor(() => expect(within(panel).getByText('문제 2 본문')).toBeInTheDocument());
    // Opening the panel never reads the question with its answers.
    expect(getQuestionAction).not.toHaveBeenCalled();
    expect(openPracticeSession).toHaveBeenCalledTimes(1);

    await user.click(within(panel).getByRole('button', { name: '문제 관리' }));
    await user.click(await screen.findByRole('menuitem', { name: '편집' }));
    const form = await screen.findByRole('dialog', { name: '문제 편집' });
    expect(getQuestionAction).toHaveBeenCalledWith(WS, id(2));
    expect(questionEditorContextAction).toHaveBeenCalledWith(WS);
    const stem = within(form).getByRole('textbox', { name: '문제 내용' });
    expect(stem).toHaveValue('문제 2 본문');
    await user.clear(stem);
    await user.type(stem, '고친 본문');
    await user.click(within(form).getByRole('button', { name: '저장' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '문제 편집' })).toBeNull());
    expect(updateQuestionAction.mock.calls[0]?.slice(0, 3)).toEqual([
      WS,
      id(2),
      '88888888-8888-4888-8888-888888888888',
    ]);
    // The panel stays on the question and opens a session of the new revision.
    await waitFor(() => expect(openPracticeSession).toHaveBeenCalledTimes(2));
    expect(new URLSearchParams(window.location.search).get('question')).toBe(id(2));
  });

  it('QPLAY-01-AC08 삭제 asks first, deletes and closes the panel', async () => {
    const user = userEvent.setup();
    deleteQuestionAction.mockResolvedValue({ ok: true, data: null });
    render(<Screen />);
    await user.click(dot(3));
    const panel = await screen.findByRole('dialog', { name: '3번 문제' });

    await user.click(within(panel).getByRole('button', { name: '문제 관리' }));
    await user.click(await screen.findByRole('menuitem', { name: '삭제' }));
    let confirm = await screen.findByRole('alertdialog', { name: '문제를 삭제할까요?' });
    await user.click(within(confirm).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deleteQuestionAction).not.toHaveBeenCalled();

    await user.click(within(panel).getByRole('button', { name: '문제 관리' }));
    await user.click(await screen.findByRole('menuitem', { name: '삭제' }));
    confirm = await screen.findByRole('alertdialog', { name: '문제를 삭제할까요?' });
    await user.click(within(confirm).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(deleteQuestionAction).toHaveBeenCalledWith(WS, id(3)));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(new URLSearchParams(window.location.search).has('question')).toBe(false);
  });

  it('QPLAY-01-AC08 a refused delete keeps the panel open and says why', async () => {
    const user = userEvent.setup();
    deleteQuestionAction.mockResolvedValue({
      ok: false,
      kind: 'forbidden',
      message: '이 작업을 할 권한이 없습니다.',
    });
    render(<Screen />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '1번 문제' });
    await user.click(within(panel).getByRole('button', { name: '문제 관리' }));
    await user.click(await screen.findByRole('menuitem', { name: '삭제' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: '삭제' }));
    expect(await screen.findByText('이 작업을 할 권한이 없습니다.')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('question')).toBe(id(1));
  });

  it.each(['viewer', 'archived'] as const)(
    'QPLAY-01-AC08 a %s gets no 문제 관리 menu',
    async (readOnly) => {
      const user = userEvent.setup();
      render(<Screen readOnly={readOnly} />);
      await user.click(dot(1));
      const panel = await screen.findByRole('dialog', { name: '1번 문제' });
      expect(within(panel).queryByRole('button', { name: '문제 관리' })).toBeNull();
    },
  );
});

describe('UX7-BANK-2 정답·해설 보기 and 보관 in the practice panel', { timeout: 20_000 }, () => {
  it.each([null, 'viewer', 'archived'] as const)(
    'QPLAY-01-AC09 the menu (%s) reads the answer only when chosen and keeps the session',
    async (readOnly) => {
      const user = userEvent.setup();
      getQuestionAction.mockResolvedValue({ ok: true, data: fullQuestion(2) });
      render(<Screen readOnly={readOnly} />);
      await user.click(dot(2));
      const panel = await screen.findByRole('dialog', { name: '2번 문제' });
      const sessions = openPracticeSession.mock.calls.length;
      expect(getQuestionAction).not.toHaveBeenCalled();
      const label = readOnly ? '문제 정보' : '문제 관리';
      await user.click(within(panel).getByRole('button', { name: label }));
      const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
      expect(items).toEqual(
        readOnly
          ? ['정답·해설 보기', '수정 이력·출처']
          : ['정답·해설 보기', '수정 이력·출처', '편집', '보관', '삭제'],
      );
      await user.click(screen.getByRole('menuitem', { name: '정답·해설 보기' }));
      const detail = await screen.findByRole('dialog', { name: '문제 상세' });
      expect(await within(detail).findByRole('heading', { name: '해설' })).toBeInTheDocument();
      expect(within(detail).getByText('정답')).toBeInTheDocument();
      expect(getQuestionAction).toHaveBeenCalledWith(WS, id(2));
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '문제 상세' })).toBeNull());
      // No new session, no submission: the practice is untouched.
      expect(openPracticeSession).toHaveBeenCalledTimes(sessions);
      expect(submitPracticeAction).not.toHaveBeenCalled();
      expect(new URLSearchParams(window.location.search).get('question')).toBe(id(2));
    },
  );

  it('QPLAY-01-AC10 수정 이력·출처 focuses the history and previews a past revision', async () => {
    const user = userEvent.setup();
    const current = fullQuestion(1, '지금 본문');
    getQuestionAction.mockResolvedValue({
      ok: true,
      data: {
        ...current,
        revision: { ...current.revision, version: 2 },
        revisions: [
          { id: current.revision.id, version: 2, created_at: '2026-10-18T00:00:00Z' },
          {
            id: '77777777-7777-4777-8777-777777777777',
            version: 1,
            created_at: '2026-10-17T00:00:00Z',
          },
        ],
      },
    });
    getQuestionRevisionAction.mockResolvedValue({
      ok: true,
      data: {
        ...current.revision,
        id: '77777777-7777-4777-8777-777777777777',
        version: 1,
        stem: '처음 본문',
      },
    });
    render(<Screen readOnly="viewer" />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '1번 문제' });
    await user.click(within(panel).getByRole('button', { name: '문제 정보' }));
    await user.click(screen.getByRole('menuitem', { name: '수정 이력·출처' }));
    const detail = await screen.findByRole('dialog', { name: '문제 상세' });
    await waitFor(() =>
      expect(within(detail).getByRole('heading', { name: '수정 이력' })).toHaveFocus(),
    );
    const v1 = await within(detail).findByRole('button', { name: /^버전 1 ·/ });
    expect(within(detail).getByRole('button', { name: /^버전 2 \(현재\)/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(v1);
    expect(await within(detail).findByText('처음 본문')).toBeInTheDocument();
    expect(v1).toHaveAttribute('aria-pressed', 'true');
  });

  it('QPLAY-01-AC11 보관 confirms, archives the current revision and closes the panel', async () => {
    const user = userEvent.setup();
    getQuestionAction.mockResolvedValue({ ok: true, data: fullQuestion(3) });
    setQuestionStatusAction.mockResolvedValue({
      ok: true,
      data: { ...fullQuestion(3), publication_status: 'ARCHIVED' },
    });
    const onQuestionsChanged = vi.fn();
    render(<Screen onQuestionsChanged={onQuestionsChanged} />);
    await user.click(dot(3));
    const panel = await screen.findByRole('dialog', { name: '3번 문제' });
    await user.click(within(panel).getByRole('button', { name: '문제 관리' }));
    await user.click(await screen.findByRole('menuitem', { name: '보관' }));
    let confirm = await screen.findByRole('alertdialog', { name: '문제를 보관할까요?' });
    await user.click(within(confirm).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(setQuestionStatusAction).not.toHaveBeenCalled();

    await user.click(within(panel).getByRole('button', { name: '문제 관리' }));
    await user.click(await screen.findByRole('menuitem', { name: '보관' }));
    confirm = await screen.findByRole('alertdialog', { name: '문제를 보관할까요?' });
    await user.click(within(confirm).getByRole('button', { name: '보관' }));
    await waitFor(() =>
      expect(setQuestionStatusAction).toHaveBeenCalledWith(
        WS,
        id(3),
        '88888888-8888-4888-8888-888888888888',
        'ARCHIVED',
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(new URLSearchParams(window.location.search).has('question')).toBe(false);
    // An open 보관·초안 문제 list must re-read (the home bumps its refreshKey).
    expect(onQuestionsChanged).toHaveBeenCalledTimes(1);
  });
});

const EMPTY: QuestionOverview = { ...overview, chapters: [], items: [] };

describe('UX7-BANK 문제 등록 on the home', () => {
  it('QOV-01-AC12 the empty heatmap asks the home to open the editor, which then shows', async () => {
    const user = userEvent.setup();
    const onCreateOpenChange = vi.fn();
    const { rerender } = render(
      <Screen
        data={EMPTY}
        filters={EMPTY_OVERVIEW_FILTERS}
        onCreateOpenChange={onCreateOpenChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: '문제 등록' }));
    expect(onCreateOpenChange).toHaveBeenCalledWith(true);

    rerender(
      <Screen
        data={EMPTY}
        filters={EMPTY_OVERVIEW_FILTERS}
        createOpen
        onCreateOpenChange={onCreateOpenChange}
      />,
    );
    const form = await screen.findByRole('dialog', { name: '문제 등록' });
    expect(questionEditorContextAction).toHaveBeenCalledWith(WS);
    await user.keyboard('{Escape}');
    expect(onCreateOpenChange).toHaveBeenLastCalledWith(false);
    expect(form).toBeInTheDocument(); // the home closes it by dropping the panel from the URL
  });

  it('QOV-01-AC12 viewers and archived workspaces get neither the button nor the editor', () => {
    render(<Screen data={EMPTY} filters={EMPTY_OVERVIEW_FILTERS} readOnly="viewer" createOpen />);
    expect(screen.queryByRole('button', { name: '문제 등록' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: '문제 등록' })).toBeNull();
  });
});

describe(
  'UX7-BANK review fixes: invalidate the edited or deleted question only',
  { timeout: 20_000 },
  () => {
    const sessionsFor = (n: number) =>
      openPracticeSession.mock.calls.filter((c) => c[1] === id(n)).length;

    it('QPLAY-01-AC08 browser Back to a deleted question never reopens it from the local state', async () => {
      const user = userEvent.setup();
      deleteQuestionAction.mockResolvedValue({ ok: true, data: null });
      render(<Screen />);
      await user.click(dot(3));
      let panel = await screen.findByRole('dialog', { name: '3번 문제' });
      await waitFor(() => expect(within(panel).getByText('문제 3 본문')).toBeInTheDocument());
      await user.click(within(panel).getByRole('button', { name: '문제 관리' }));
      await user.click(await screen.findByRole('menuitem', { name: '삭제' }));
      const confirm = await screen.findByRole('alertdialog', { name: '문제를 삭제할까요?' });
      await user.click(within(confirm).getByRole('button', { name: '삭제' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      // Back restores `?question=<deleted id>`: no panel, no answer controls, no cached session.
      await act(async () => {
        realPushState(null, '', `${PATH}?question=${id(3)}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(screen.queryByRole('dialog', { name: '3번 문제' })).toBeNull();
      expect(screen.queryByRole('button', { name: '제출' })).toBeNull();
      expect(sessionsFor(3)).toBe(1);

      // Other questions still open normally.
      realPushState(null, '', PATH);
      await act(async () => {
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await user.click(dot(1));
      panel = await screen.findByRole('dialog', { name: '1번 문제' });
      expect(panel).toBeVisible();
    });

    it('QPLAY-01-AC07 a save that lands after the editor closed refreshes only the saved question', async () => {
      const user = userEvent.setup();
      getQuestionAction.mockResolvedValue({ ok: true, data: fullQuestion(1) });
      let finishSave: (value: unknown) => void = () => undefined;
      updateQuestionAction.mockReturnValue(new Promise((resolve) => (finishSave = resolve)));
      render(<Screen />);
      await user.click(dot(1));
      let panel = await screen.findByRole('dialog', { name: '1번 문제' });
      await waitFor(() => expect(within(panel).getByText('문제 1 본문')).toBeInTheDocument());

      await user.click(within(panel).getByRole('button', { name: '문제 관리' }));
      await user.click(await screen.findByRole('menuitem', { name: '편집' }));
      const form = await screen.findByRole('dialog', { name: '문제 편집' });
      await user.click(within(form).getByRole('button', { name: '저장' }));
      // Dismiss the pending dialog and move on to question 2 before the save completes.
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '문제 편집' })).toBeNull());
      await user.click(within(panel).getByRole('button', { name: '다음 문제' }));
      panel = await screen.findByRole('dialog', { name: '2번 문제' });
      await waitFor(() => expect(within(panel).getByText('문제 2 본문')).toBeInTheDocument());
      expect(sessionsFor(2)).toBe(1);

      await act(async () => finishSave({ ok: true, data: fullQuestion(1, '고친 본문') }));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      // Question 2 keeps its session (no reload, no lost answer state)...
      expect(sessionsFor(2)).toBe(1);
      // ...and question 1's cached session of the old revision is gone: back to it opens a new one.
      expect(sessionsFor(1)).toBe(1);
      await user.click(within(panel).getByRole('button', { name: '이전 문제' }));
      await screen.findByRole('dialog', { name: '1번 문제' });
      await waitFor(() => expect(sessionsFor(1)).toBe(2));
    });
  },
);

interface Ctx {
  user: ReturnType<typeof userEvent.setup>;
  panel: HTMLElement;
  held: { resolve: (value: unknown) => void }[];
}

describe('UX9-RETRY-OPT optimistic favorite / retry toggles in the practice panel', () => {
  interface Flags {
    is_favorite: boolean;
    needs_retry: boolean;
  }
  interface Held {
    patch: Partial<Flags>;
    resolve: (value: unknown) => void;
  }
  let held: Held[] = [];
  beforeEach(() => {
    held = [];
    setMyStateAction.mockImplementation(
      (_ws: string, _qid: string, patch: Partial<Flags>) =>
        new Promise((resolve) => held.push({ patch, resolve })),
    );
  });
  const myStateOf = (flags: Flags) => ({
    ok: true,
    data: {
      question_id: id(1),
      status: flags.needs_retry ? 'retry' : 'correct',
      last_graded_result: 'correct',
      ...flags,
    },
  });
  const answer = (i: number, flags: Flags) => act(async () => held[i]?.resolve(myStateOf(flags)));
  const toggles = (panel: HTMLElement) => {
    const found = within(panel)
      .getAllByRole('button')
      .filter((b) => b.classList.contains('qz-study-toggle'));
    return { favorite: found[0] as HTMLElement, retry: found[1] as HTMLElement };
  };
  const snapshot = (el: Element) =>
    ['aria-label', 'data-state', 'aria-disabled', 'disabled', 'title']
      .map((a) => `${a}=${el.getAttribute(a)}`)
      .join(' ');
  // The heatmap is hidden from the accessibility tree while the modal panel is open.
  const markerShape = () =>
    document
      .querySelector(`[data-question-id="${id(1)}"] [data-testid="question-marker"]`)
      ?.getAttribute('data-shape');
  async function openPanel() {
    const user = userEvent.setup();
    render(<Screen data={correctOverview} filters={EMPTY_OVERVIEW_FILTERS} />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '1번 문제' });
    return { user, panel };
  }

  it('the retry toggle and the dot flip before the server answers, without a busy state', async () => {
    const { user, panel } = await openPanel();
    await user.click(within(panel).getByRole('button', { name: '다시 풀기 표시' }));
    const retry = within(panel).getByRole('button', { name: '다시 풀기 해제' });
    expect(retry).toHaveAttribute('data-state', 'on');
    expect(retry).not.toHaveAttribute('aria-disabled');
    expect(held).toHaveLength(1);
    expect(dotStatus(1)).toBe('retry');
    await answer(0, { is_favorite: false, needs_retry: true });
    expect(within(panel).getByRole('button', { name: '다시 풀기 해제' })).toBe(retry);
    expect(dotStatus(1)).toBe('retry');
  });

  it('toggling favorite never changes the retry toggle, before or after the response', async () => {
    const { user, panel } = await openPanel();
    await user.click(within(panel).getByRole('button', { name: '다시 풀기 표시' }));
    await answer(0, { is_favorite: false, needs_retry: true });
    const retry = within(panel).getByRole('button', { name: '다시 풀기 해제' });
    const before = snapshot(retry);
    const seen = new Set<string>();
    const observer = new MutationObserver(() => {
      const now = within(panel).queryByRole('button', { name: /다시 풀기 (표시|해제)/ });
      seen.add(now === retry ? snapshot(retry) : 'remounted');
    });
    observer.observe(panel, { subtree: true, attributes: true, childList: true });
    await user.click(within(panel).getByRole('button', { name: '즐겨찾기 추가' }));
    expect(snapshot(retry)).toBe(before);
    expect(within(panel).getByRole('button', { name: '즐겨찾기 해제' })).toBeInTheDocument();
    await answer(1, { is_favorite: true, needs_retry: true });
    expect(within(panel).getByRole('button', { name: '즐겨찾기 해제' })).toBeInTheDocument();
    observer.disconnect();
    expect(snapshot(retry)).toBe(before);
    expect([...seen].filter((s) => s !== before)).toEqual([]);
    expect(held.map((h) => h.patch)).toEqual([{ needs_retry: true }, { is_favorite: true }]);
  });

  it('rapid presses end in the last intent: one request at a time, coalesced', async () => {
    const { user, panel } = await openPanel();
    const { retry } = toggles(panel);
    await user.click(retry); // on (sent)
    await user.click(retry); // off
    await user.click(retry); // on
    await user.click(retry); // off
    expect(retry).toHaveAttribute('data-state', 'off');
    expect(held).toHaveLength(1);
    // The first response (on) is older than the last intent (off): the toggle keeps the intent
    // and the difference goes in the next request.
    await answer(0, { is_favorite: false, needs_retry: true });
    expect(retry).toHaveAttribute('data-state', 'off');
    expect(dotStatus(1)).not.toBe('retry');
    expect(held.map((h) => h.patch)).toEqual([{ needs_retry: true }, { needs_retry: false }]);
    await answer(1, { is_favorite: false, needs_retry: false });
    expect(retry).toHaveAttribute('data-state', 'off');
    expect(held).toHaveLength(2);
  });

  it('presses on both toggles while one request is in flight go in one next request', async () => {
    const { user, panel } = await openPanel();
    const { favorite, retry } = toggles(panel);
    await user.click(favorite);
    await user.click(retry);
    await user.click(favorite);
    await user.click(favorite);
    expect(held).toHaveLength(1);
    await answer(0, { is_favorite: true, needs_retry: false });
    expect(held.map((h) => h.patch)).toEqual([{ is_favorite: true }, { needs_retry: true }]);
    await answer(1, { is_favorite: true, needs_retry: true });
    expect(favorite).toHaveAttribute('data-state', 'on');
    expect(retry).toHaveAttribute('data-state', 'on');
    expect(markerShape()).toBe('star');
    expect(dotStatus(1)).toBe('retry');
  });

  it('a failed request rolls only its own field back and reports it; the other press is saved', async () => {
    const { user, panel } = await openPanel();
    const { favorite, retry } = toggles(panel);
    await user.click(retry);
    await user.click(favorite);
    expect(retry).toHaveAttribute('data-state', 'on');
    expect(favorite).toHaveAttribute('data-state', 'on');
    await act(async () =>
      held[0]?.resolve({ ok: false, kind: 'unavailable', message: '일시적인 오류입니다.' }),
    );
    expect(await screen.findByText(/일시적인 오류/)).toBeInTheDocument();
    expect(retry).toHaveAttribute('data-state', 'off');
    expect(favorite).toHaveAttribute('data-state', 'on');
    expect(held.map((h) => h.patch)).toEqual([{ needs_retry: true }, { is_favorite: true }]);
    await answer(1, { is_favorite: true, needs_retry: false });
    expect(favorite).toHaveAttribute('data-state', 'on');
    expect(retry).toHaveAttribute('data-state', 'off');
    expect(markerShape()).toBe('star');
    expect(dotStatus(1)).not.toBe('retry');
  });

  it('RETRY-01-C04 a refused retry (409) shows the dedicated message and hides the toggle', async () => {
    lookupOverviewQuestionAction.mockResolvedValue({ ok: true, data: outsidePlaced(1) });
    const { user, panel } = await openPanel();
    await user.click(toggles(panel).retry);
    await act(async () =>
      held[0]?.resolve({
        ok: false,
        kind: 'retryNotAllowed',
        message: '정답을 맞힌 문제만 다시 풀기로 표시할 수 있습니다.',
      }),
    );
    expect(
      await screen.findByText('정답을 맞힌 문제만 다시 풀기로 표시할 수 있습니다.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(panel).queryByRole('button', { name: /다시 풀기 (표시|해제)/ })).toBeNull(),
    );
    expect(lookupOverviewQuestionAction).toHaveBeenCalledWith(WS, id(1));
    expect(within(panel).getByRole('button', { name: /즐겨찾기/ })).toBeInTheDocument();
  });

  // RETRY-01-C04: a refused retry (409) re-reads the question while the user keeps working. Per
  // field (favorite, retry flag, grading) the server's answer counts only if this screen did not
  // change the field after the lookup started; the toggle follows the merged state.
  describe.each([
    {
      name: 'nothing changed meanwhile: the server wins and the toggle is hidden',
      meanwhile: async () => undefined,
      expectState: async (panel: HTMLElement) => {
        expect(within(panel).getByRole('button', { name: '즐겨찾기 추가' })).toBeInTheDocument();
        expect(within(panel).queryByRole('button', { name: /다시 풀기 (표시|해제)/ })).toBeNull();
      },
    },
    {
      name: 'a favorite pressed meanwhile stays on, the toggle is hidden',
      meanwhile: async ({
        user,
        panel,
      }: {
        user: ReturnType<typeof userEvent.setup>;
        panel: HTMLElement;
      }) => {
        await user.click(toggles(panel).favorite);
      },
      expectState: async (panel: HTMLElement) => {
        expect(within(panel).getByRole('button', { name: '즐겨찾기 해제' })).toHaveAttribute(
          'data-state',
          'on',
        );
        expect(within(panel).queryByRole('button', { name: /다시 풀기 (표시|해제)/ })).toBeNull();
      },
    },
    {
      name: 'a correct answer and a saved retry ON meanwhile stay on',
      meanwhile: async ({ user, panel, held }: Ctx) => {
        submitPracticeAction.mockResolvedValue(
          submitted('correct', { correct_option_ids: ['o1'] }),
        );
        await user.click(await within(panel).findByRole('radio', { name: '보기 하나' }));
        await user.click(within(panel).getByRole('button', { name: '제출' }));
        await within(panel).findByText('정답입니다.');
        await user.click(within(panel).getByRole('button', { name: '다시 풀기 표시' }));
        await act(async () =>
          held[1]?.resolve({
            ok: true,
            data: {
              question_id: id(1),
              status: 'retry',
              is_favorite: false,
              needs_retry: true,
              last_graded_result: 'correct',
            },
          }),
        );
      },
      expectState: async (panel: HTMLElement) => {
        expect(within(panel).getByRole('button', { name: '다시 풀기 해제' })).toHaveAttribute(
          'data-state',
          'on',
        );
        expect(dotStatus(1)).toBe('retry');
      },
    },
    {
      name: 'an incorrect answer meanwhile: no retry flag, the toggle is hidden',
      meanwhile: async ({ user, panel }: Ctx) => {
        submitPracticeAction.mockResolvedValue(
          submitted('incorrect', { correct_option_ids: ['o2'] }),
        );
        await user.click(await within(panel).findByRole('radio', { name: '보기 하나' }));
        await user.click(within(panel).getByRole('button', { name: '제출' }));
        await within(panel).findByText('오답입니다.');
      },
      expectState: async (panel: HTMLElement) => {
        expect(within(panel).queryByRole('button', { name: /다시 풀기 (표시|해제)/ })).toBeNull();
        expect(dotStatus(1)).toBe('incorrect');
      },
    },
  ])('RETRY-01-C04 re-read after a refused retry', ({ name, meanwhile, expectState }) => {
    it(name, async () => {
      let release!: (value: unknown) => void;
      lookupOverviewQuestionAction.mockImplementation(
        () => new Promise((resolve) => (release = resolve)),
      );
      const opened = await openPanel();
      await opened.user.click(toggles(opened.panel).retry);
      await act(async () =>
        held[0]?.resolve({
          ok: false,
          kind: 'retryNotAllowed',
          message: '정답을 맞힌 문제만 다시 풀기로 표시할 수 있습니다.',
        }),
      );
      await screen.findByText('정답을 맞힌 문제만 다시 풀기로 표시할 수 있습니다.');
      // The server's answer (never graded, no flags) arrives after whatever happened meanwhile.
      await meanwhile({ ...opened, held });
      await act(async () => release({ ok: true, data: outsidePlaced(1) }));
      await waitFor(async () => expectState(opened.panel));
    });
  });

  async function refuseRetry(user: ReturnType<typeof userEvent.setup>, panel: HTMLElement) {
    await user.click(toggles(panel).retry);
    await act(async () =>
      held[0]?.resolve({
        ok: false,
        kind: 'retryNotAllowed',
        message: '정답을 맞힌 문제만 다시 풀기로 표시할 수 있습니다.',
      }),
    );
    await screen.findByText('정답을 맞힌 문제만 다시 풀기로 표시할 수 있습니다.');
  }

  it('RETRY-01-C04 a favorite still being saved survives an overview refresh after the re-read', async () => {
    let release!: (value: unknown) => void;
    lookupOverviewQuestionAction.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    const user = userEvent.setup();
    const { rerender } = render(<Screen data={correctOverview} filters={EMPTY_OVERVIEW_FILTERS} />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '1번 문제' });
    await refuseRetry(user, panel);
    await user.click(toggles(panel).favorite); // held[1]: the save is in flight
    await act(async () => release({ ok: true, data: outsidePlaced(1) }));
    // A newer server overview arrives (it does not know the favorite yet) before the save ends.
    rerender(
      <Screen
        data={{ ...correctOverview, items: [...correctOverview.items] }}
        filters={EMPTY_OVERVIEW_FILTERS}
      />,
    );
    expect(within(panel).getByRole('button', { name: '즐겨찾기 해제' })).toHaveAttribute(
      'data-state',
      'on',
    );
  });

  it('RETRY-01-C04 a failed favorite save does not stamp the retry flag of the re-read', async () => {
    let release!: (value: unknown) => void;
    lookupOverviewQuestionAction.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    const { user, panel } = await openPanel();
    await refuseRetry(user, panel);
    await user.click(toggles(panel).favorite);
    await act(async () =>
      held[1]?.resolve({ ok: false, kind: 'unavailable', message: '일시적인 오류입니다.' }),
    );
    // The server has the retry flag on (set long ago): the favorite failure did not touch it.
    const server = outsidePlaced(1);
    await act(async () =>
      release({
        ok: true,
        data: { ...server, item: { ...server.item, status: 'retry', needs_retry: true } },
      }),
    );
    await waitFor(() => expect(dotStatus(1)).toBe('retry'));
    expect(within(panel).queryByRole('button', { name: /다시 풀기 (표시|해제)/ })).toBeNull();
  });

  it('a rejected request after a saved change keeps the saved change', async () => {
    const { user, panel } = await openPanel();
    const { favorite, retry } = toggles(panel);
    await user.click(retry);
    await answer(0, { is_favorite: false, needs_retry: true });
    await user.click(favorite);
    await act(async () => held[1]?.resolve(Promise.reject(new TypeError('Failed to fetch'))));
    expect(await screen.findByText(/일시적인 오류/)).toBeInTheDocument();
    expect(favorite).toHaveAttribute('data-state', 'off');
    expect(retry).toHaveAttribute('data-state', 'on');
    expect(dotStatus(1)).toBe('retry');
  });

  it('a save of a deep-linked question outside the list settles after another question opened', async () => {
    const user = userEvent.setup();
    const navigate = (search: string) =>
      act(async () => {
        realPushState(null, '', `${PATH}${search}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
    realPushState(null, '', `${PATH}?favorite=true&question=${id(2)}`);
    render(<Screen data={only(1, 3)} requested={outsidePlaced(2)} />);
    let panel = await screen.findByRole('dialog', { name: '2번 문제' });
    await user.click(within(panel).getByRole('button', { name: '즐겨찾기 추가' }));
    expect(within(panel).getByRole('button', { name: '즐겨찾기 해제' })).toBeInTheDocument();
    await navigate(`?favorite=true&question=${id(1)}`);
    await screen.findByRole('dialog', { name: '1번 문제' });
    await act(async () =>
      held[0]?.resolve({ ok: false, kind: 'unavailable', message: '일시적인 오류입니다.' }),
    );
    expect(await screen.findByText(/일시적인 오류/)).toBeInTheDocument();
    await navigate(`?favorite=true&question=${id(2)}`);
    panel = await screen.findByRole('dialog', { name: '2번 문제' });
    expect(within(panel).getByRole('button', { name: '즐겨찾기 추가' })).toBeInTheDocument();
  });
});
