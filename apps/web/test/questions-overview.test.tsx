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
import type { QuestionOverview } from '../src/lib/questions/overview-data';
import { EMPTY_OVERVIEW_FILTERS } from '../src/lib/questions/overview-filters';

// `useSearchParams` follows window.location like Next.js does for history.pushState.
const subscribe = (notify: () => void) => {
  window.addEventListener('popstate', notify);
  window.addEventListener('test:pushstate', notify);
  return () => {
    window.removeEventListener('popstate', notify);
    window.removeEventListener('test:pushstate', notify);
  };
};
vi.mock('next/navigation', () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () =>
    new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search)),
}));

const openPracticeSessionAction = vi.fn();
const setMyStateAction = vi.fn();
vi.mock('../src/lib/questions/practice-actions', () => ({
  openPracticeSessionAction: (...a: unknown[]) => openPracticeSessionAction(...a),
  setMyStateAction: (...a: unknown[]) => setMyStateAction(...a),
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

function Screen() {
  return (
    <ToastProvider>
      <main>
        <QuestionsOverview
          workspaceId={WS}
          readOnly={null}
          filters={EMPTY_OVERVIEW_FILTERS}
          overview={overview}
          chapterChoices={[{ value: 'none', title: '챕터 없음' }]}
          failure={null}
        />
      </main>
    </ToastProvider>
  );
}

const realPushState = window.history.pushState.bind(window.history);

beforeEach(() => {
  openPracticeSessionAction.mockReset();
  setMyStateAction.mockReset();
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
