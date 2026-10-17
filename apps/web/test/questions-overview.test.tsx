// @vitest-environment jsdom
// QOV-01 screen: opening a dot puts `?question=` in the URL and opens the modal practice panel
// (which opens a practice session = the view); closing it removes the param and returns focus to
// the dot — also when the panel was opened by a deep link. Hovering never opens a session.
import './dom-setup';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@quiz/ui';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: routerRefresh }),
  useSearchParams: () =>
    new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search)),
}));

const openPracticeSessionAction = vi.fn();
const setMyStateAction = vi.fn();
const lookupOverviewQuestionAction = vi.fn();
const submitPracticeAction = vi.fn();
const selfGradePracticeAction = vi.fn();
vi.mock('../src/lib/questions/practice-actions', () => ({
  submitPracticeAction: (...a: unknown[]) => submitPracticeAction(...a),
  selfGradePracticeAction: (...a: unknown[]) => selfGradePracticeAction(...a),
  openPracticeSessionAction: (...a: unknown[]) => openPracticeSessionAction(...a),
  setMyStateAction: (...a: unknown[]) => setMyStateAction(...a),
  lookupOverviewQuestionAction: (...a: unknown[]) => lookupOverviewQuestionAction(...a),
}));

const { QuestionsOverview } =
  await import('../src/components/questions/overview/questions-overview');

const WS = '55555555-5555-4555-8555-555555555555';
const PATH = `/workspaces/${WS}/questions`;
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
}: {
  data?: QuestionOverview;
  requested?: PlacedQuestion | null;
}) {
  return (
    <ToastProvider>
      <main>
        <QuestionsOverview
          workspaceId={WS}
          readOnly={null}
          filters={data === overview ? EMPTY_OVERVIEW_FILTERS : FAVORITES}
          overview={data}
          chapterChoices={[{ value: 'none', title: '챕터 없음' }]}
          failure={null}
          requested={requested}
        />
      </main>
    </ToastProvider>
  );
}

const realPushState = window.history.pushState.bind(window.history);

beforeEach(() => {
  openPracticeSessionAction.mockReset();
  setMyStateAction.mockReset();
  lookupOverviewQuestionAction.mockReset();
  submitPracticeAction.mockReset();
  selfGradePracticeAction.mockReset();
  routerRefresh.mockReset();
  lookupOverviewQuestionAction.mockResolvedValue({ ok: true, data: null });
  openPracticeSessionAction.mockImplementation((_ws: string, qid: string) =>
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

    const panel = await screen.findByRole('dialog', { name: '챕터 없음 2번 문제' });
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(new URLSearchParams(window.location.search).get('question')).toBe(id(2));
    await waitFor(() => expect(within(panel).getByText('문제 2 본문')).toBeInTheDocument());
    expect(openPracticeSessionAction).toHaveBeenCalledTimes(1);
    expect(openPracticeSessionAction.mock.calls[0]?.slice(0, 2)).toEqual([WS, id(2)]);
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
    const panel = await screen.findByRole('dialog', { name: '챕터 없음 3번 문제' });
    await user.click(within(panel).getByRole('button', { name: '패널 닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(dot(3)).toHaveFocus();
  });

  it('back/forward (popstate) closes and reopens the panel', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await user.click(dot(1));
    await screen.findByRole('dialog', { name: '챕터 없음 1번 문제' });
    await act(async () => {
      realPushState(null, '', PATH);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => {
      realPushState(null, '', `${PATH}?question=${id(1)}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(await screen.findByRole('dialog', { name: '챕터 없음 1번 문제' })).toBeVisible();
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
    const panel = await screen.findByRole('dialog', { name: '챕터 없음 1번 문제' });
    await user.click(within(panel).getByRole('button', { name: '즐겨찾기 추가' }));
    expect(within(panel).getByRole('button', { name: '즐겨찾기 해제' })).toBeInTheDocument();
    expect(setMyStateAction).toHaveBeenCalledWith(WS, id(1), { is_favorite: true });
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
    expect(openPracticeSessionAction).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });
});

describe('QuestionsOverview review fixes', () => {
  it('a deep link outside the filtered list opens from the server-resolved question', async () => {
    realPushState(null, '', `${PATH}?favorite=true&question=${id(2)}`);
    render(<Screen data={only(1, 3)} requested={outsidePlaced(2)} />);
    const panel = await screen.findByRole('dialog', { name: '챕터 없음 2번 문제' });
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
    expect(await screen.findByRole('dialog', { name: '챕터 없음 2번 문제' })).toBeVisible();
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
    expect(await screen.findByRole('dialog', { name: '챕터 없음 2번 문제' })).toBeVisible();
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
    await screen.findByRole('dialog', { name: '챕터 없음 2번 문제' });
    // The question leaves the (favorites) list while the panel is open.
    rerender(<Screen data={only(1, 3)} />);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(dot(3)).toHaveFocus();
  });

  it('focus goes to the search box when the heatmap is empty after closing', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Screen />);
    await user.click(dot(1));
    await screen.findByRole('dialog', { name: '챕터 없음 1번 문제' });
    rerender(<Screen data={only()} />);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('searchbox', { name: '문제 검색' })).toHaveFocus();
  });

  it('a rejected my-state request rolls the optimistic change back and reports it', async () => {
    const user = userEvent.setup();
    setMyStateAction.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<Screen />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '챕터 없음 1번 문제' });
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
    let panel = await screen.findByRole('dialog', { name: '챕터 없음 1번 문제' });
    expect(within(panel).getByRole('button', { name: '이전 문제' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(within(panel).getByRole('button', { name: '다음 문제' }));
    panel = await screen.findByRole('dialog', { name: '챕터 없음 2번 문제' });
    expect(new URLSearchParams(window.location.search).get('question')).toBe(id(2));
    await user.click(within(panel).getByRole('button', { name: '다음 문제' }));
    panel = await screen.findByRole('dialog', { name: '챕터 없음 3번 문제' });
    const next = within(panel).getByRole('button', { name: '다음 문제' });
    expect(next).toHaveAttribute('aria-disabled', 'true');
    await user.click(next);
    expect(new URLSearchParams(window.location.search).get('question')).toBe(id(3));
    // Each question opened its own session (= its own view).
    await waitFor(() => expect(openPracticeSessionAction).toHaveBeenCalledTimes(3));

    await user.click(within(panel).getByRole('button', { name: '이전 문제' }));
    await screen.findByRole('dialog', { name: '챕터 없음 2번 문제' });
    expect(new URLSearchParams(window.location.search).get('question')).toBe(id(2));
  });

  it('submits the chosen option id, reveals the answer only then and refreshes on close', async () => {
    const user = userEvent.setup();
    submitPracticeAction.mockResolvedValue(
      submitted('correct', { correct_option_ids: ['o1'], explanation: '해설 본문' }),
    );
    render(<Screen />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '챕터 없음 1번 문제' });
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
    openPracticeSessionAction.mockImplementation((_ws: string, qid: string) => {
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
    const panel = await screen.findByRole('dialog', { name: '챕터 없음 2번 문제' });
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
        last_graded_result: null,
      },
    });
    submitPracticeAction.mockResolvedValue(submitted('correct', { correct_option_ids: ['o1'] }));
    render(<Screen />);
    await user.click(dot(1));
    const panel = await screen.findByRole('dialog', { name: '챕터 없음 1번 문제' });
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
    const panel = await screen.findByRole('dialog', { name: '챕터 없음 3번 문제' });
    await user.click(await within(panel).findByRole('radio', { name: '보기 하나' }));
    await user.click(within(panel).getByRole('button', { name: '제출' }));
    await waitFor(() => expect(within(panel).getByRole('alert')).toHaveTextContent('일시적인'));
    expect(within(panel).getByRole('radio', { name: '보기 하나' })).toBeChecked();
    expect(within(panel).getByRole('button', { name: '제출' })).toBeEnabled();
  });
});
