// @vitest-environment jsdom
// QBANK-01 "더 보기": a page requested for one list (filters + server render) must never be
// appended to another. Responses are deferred so the filter change lands while they are pending.
import './dom-setup';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@quiz/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult, QuestionPage } from '../src/lib/questions/actions';
import { DEFAULT_FILTERS, type BankFilters } from '../src/lib/questions/filters';
import type { Question } from '../src/lib/questions/form';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/workspaces/ws/questions/bank',
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
}));

const listQuestionsAction =
  vi.fn<(ws: string, f: BankFilters, c: string | null) => Promise<ActionResult<QuestionPage>>>();
vi.mock('../src/lib/questions/actions', () => ({
  listQuestionsAction: (...a: Parameters<typeof listQuestionsAction>) => listQuestionsAction(...a),
  deleteQuestionAction: vi.fn(),
  setQuestionStatusAction: vi.fn(),
  createQuestionAction: vi.fn(),
  updateQuestionAction: vi.fn(),
  getQuestionAction: vi.fn(),
  getQuestionRevisionAction: vi.fn(),
}));

const { QuestionBank } = await import('../src/components/questions/question-bank');
const { default: BankLoading } =
  await import('../src/app/workspaces/[workspaceId]/questions/bank/loading');

const WS = '55555555-5555-4555-8555-555555555555';

function q(n: number, stem: string, type: Question['question_type'] = 'MCQ'): Question {
  return {
    id: `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`,
    workspace_id: WS,
    question_type: type,
    publication_status: 'CONFIRMED',
    origin: 'manual',
    chapter_id: null,
    chapter: null,
    question_number: null,
    revision: {
      id: `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`,
      version: 1,
      stem,
      options: [],
      correct_option_ids: null,
      accepted_answers: null,
      is_multi_answer: false,
      explanation: null,
      rubric: null,
      created_at: '2026-10-17T00:00:00Z',
    },
    sources: [],
    created_at: '2026-10-17T00:00:00Z',
    updated_at: '2026-10-17T00:00:00Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function Bank(props: { filters: BankFilters; items: Question[]; nextCursor: string | null }) {
  return (
    <ToastProvider>
      <QuestionBank
        workspaceId={WS}
        readOnly={null}
        failure={null}
        chapters={[]}
        documents={[]}
        {...props}
      />
    </ToastProvider>
  );
}

// Question rows only (the breadcrumb is a list too).
const stems = () =>
  within(screen.getByRole('main'))
    .queryAllByRole('listitem')
    .filter((li) => !li.closest('nav'));

beforeEach(() => {
  listQuestionsAction.mockReset();
  replace.mockReset();
});

describe('QuestionBank title (UX6-BANK)', () => {
  it('QBANK-01-AC05 names the page 전체 문제 in the heading and the breadcrumb', () => {
    render(
      <main>
        <Bank filters={DEFAULT_FILTERS} items={[q(1, '첫 문제')]} nextCursor={null} />
      </main>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('전체 문제');
    const crumbs = screen.getByRole('navigation', { name: /위치|breadcrumb/i });
    const current = within(crumbs).getByText('전체 문제');
    expect(current.closest('[aria-current="page"]')).not.toBeNull();
    expect(screen.queryByText(/문제은행$/)).toBeNull();
  });

  it('QBANK-01-AC05 labels the loading skeleton 전체 문제', () => {
    render(<BankLoading />);
    expect(screen.getByText(/전체 문제를 불러오는 중/)).toBeInTheDocument();
  });
});

describe('QuestionBank pagination', () => {
  it('appends the next page of the same list', async () => {
    const user = userEvent.setup();
    listQuestionsAction.mockResolvedValue({
      ok: true,
      data: { items: [q(2, '둘째 문제')], nextCursor: null },
    });
    render(
      <main>
        <Bank filters={DEFAULT_FILTERS} items={[q(1, '첫 문제')]} nextCursor="c1" />
      </main>,
    );
    await user.click(screen.getByRole('button', { name: '더 보기' }));
    await waitFor(() => expect(screen.getByText('둘째 문제')).toBeInTheDocument());
    expect(listQuestionsAction).toHaveBeenCalledWith(WS, DEFAULT_FILTERS, 'c1');
    expect(screen.queryByRole('button', { name: '더 보기' })).toBeNull();
  });

  it('drops a pending page when a new server render (new filters) arrives first', async () => {
    const user = userEvent.setup();
    const page = deferred<ActionResult<QuestionPage>>();
    listQuestionsAction.mockReturnValue(page.promise);
    const { rerender } = render(
      <main>
        <Bank filters={DEFAULT_FILTERS} items={[q(1, '객관식 문제')]} nextCursor="c1" />
      </main>,
    );
    await user.click(screen.getByRole('button', { name: '더 보기' }));

    const essays: BankFilters = { ...DEFAULT_FILTERS, type: 'ESSAY' };
    rerender(
      <main>
        <Bank filters={essays} items={[q(3, '서술형 문제', 'ESSAY')]} nextCursor={null} />
      </main>,
    );
    await act(async () => {
      page.resolve({
        ok: true,
        data: { items: [q(2, '이전 필터의 다음 쪽')], nextCursor: 'c2' },
      });
      await page.promise;
    });

    expect(screen.getByText('서술형 문제')).toBeInTheDocument();
    expect(screen.queryByText('이전 필터의 다음 쪽')).toBeNull();
    expect(screen.queryByText('객관식 문제')).toBeNull();
    // The stale cursor did not come back either.
    expect(screen.queryByRole('button', { name: '더 보기' })).toBeNull();
    expect(stems()).toHaveLength(1);
  });

  it('drops a pending page as soon as the user changes a filter', async () => {
    const user = userEvent.setup();
    const page = deferred<ActionResult<QuestionPage>>();
    listQuestionsAction.mockReturnValue(page.promise);
    render(
      <main>
        <Bank filters={DEFAULT_FILTERS} items={[q(1, '첫 문제')]} nextCursor="c1" />
      </main>,
    );
    await user.click(screen.getByRole('button', { name: '더 보기' }));
    await user.click(screen.getByRole('button', { name: '검색·필터' })); // collapsed by default
    await user.click(screen.getByRole('combobox', { name: '유형' }));
    await user.click(await screen.findByRole('option', { name: '서술형' }));
    expect(replace).toHaveBeenCalledWith('/workspaces/ws/questions/bank?type=ESSAY', {
      scroll: false,
    });

    await act(async () => {
      page.resolve({ ok: true, data: { items: [q(2, '늦게 온 쪽')], nextCursor: 'c2' } });
      await page.promise;
    });
    expect(screen.queryByText('늦게 온 쪽')).toBeNull();
    expect(stems()).toHaveLength(1);
  });
});
