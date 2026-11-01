// @vitest-environment jsdom
// UX7-BANK-2 보관·초안 문제 dialog body (QOV-01-AC15): the status filter (전체 = drafts + archived,
// 초안, 보관됨) and "더 보기" paging through listInactiveQuestionsAction, editors' 보관 해제 / 확정
// (a changed question leaves the list) and the read-only roles without write controls.
import './dom-setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@quiz/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

const listInactiveQuestionsAction = vi.fn();
const setQuestionStatusAction = vi.fn();
const getQuestionAction = vi.fn();
vi.mock('../src/lib/questions/actions', () => ({
  listInactiveQuestionsAction: (...a: unknown[]) => listInactiveQuestionsAction(...a),
  setQuestionStatusAction: (...a: unknown[]) => setQuestionStatusAction(...a),
  getQuestionAction: (...a: unknown[]) => getQuestionAction(...a),
  getQuestionRevisionAction: vi.fn(),
  deleteQuestionAction: vi.fn(),
  updateQuestionAction: vi.fn(),
  createQuestionAction: vi.fn(),
  questionEditorContextAction: vi.fn().mockResolvedValue({ chapters: [], documents: [] }),
}));

const { InactiveQuestions } =
  await import('../src/components/questions/inactive/inactive-questions');

const WS = '55555555-5555-4555-8555-555555555555';
const id = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

function question(n: number, status: 'DRAFT' | 'ARCHIVED') {
  return {
    id: id(n),
    workspace_id: WS,
    question_type: 'MCQ',
    publication_status: status,
    origin: 'manual',
    chapter_id: null,
    chapter: null,
    question_number: n,
    revision: {
      id: `88888888-8888-4888-8888-${String(n).padStart(12, '0')}`,
      version: 1,
      stem: `문제 ${n} 본문`,
      options: [{ id: 'o1', text: '보기 하나' }],
      correct_option_ids: ['o1'],
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

function page(items: unknown[], nextCursor: string | null = null) {
  return { ok: true, data: { items, nextCursor } };
}

function Screen({ readOnly = null }: { readOnly?: 'viewer' | 'archived' | null }) {
  return (
    <ToastProvider>
      <InactiveQuestions workspaceId={WS} readOnly={readOnly} documents={[]} />
    </ToastProvider>
  );
}

const rows = () => within(screen.getByRole('list', { name: '문제 목록' })).getAllByRole('listitem');

beforeEach(() => {
  listInactiveQuestionsAction.mockReset();
  setQuestionStatusAction.mockReset();
  getQuestionAction.mockReset();
});

describe('UX7-BANK-2 보관·초안 문제', () => {
  it('QOV-01-AC15 lists drafts and archived questions (전체), pages with 더 보기 and filters by status', async () => {
    const user = userEvent.setup();
    listInactiveQuestionsAction.mockImplementation(
      (_ws: string, filter: string, cursor: string | null) => {
        if (filter === 'DRAFT') return Promise.resolve(page([question(1, 'DRAFT')]));
        if (cursor === 'next')
          return Promise.resolve(page([question(2, 'ARCHIVED'), question(3, 'ARCHIVED')]));
        return Promise.resolve(page([question(1, 'DRAFT'), question(2, 'ARCHIVED')], 'next'));
      },
    );
    render(<Screen />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(listInactiveQuestionsAction).toHaveBeenCalledWith(WS, 'INACTIVE', null);
    expect(rows()[0]).toHaveTextContent('초안');
    expect(rows()[1]).toHaveTextContent('보관됨');

    await user.click(screen.getByRole('button', { name: '더 보기' }));
    // The duplicate of question 2 is dropped.
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.queryByRole('button', { name: '더 보기' })).toBeNull();

    await user.click(screen.getByRole('combobox', { name: '상태' }));
    await user.click(await screen.findByRole('option', { name: '초안' }));
    await waitFor(() =>
      expect(listInactiveQuestionsAction).toHaveBeenCalledWith(WS, 'DRAFT', null),
    );
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  it('QOV-01-AC15 보관 해제 and 확정 confirm the question and drop its row', async () => {
    const user = userEvent.setup();
    listInactiveQuestionsAction.mockResolvedValue(
      page([question(1, 'DRAFT'), question(2, 'ARCHIVED')]),
    );
    setQuestionStatusAction.mockImplementation((_ws: string, qid: string) =>
      Promise.resolve({
        ok: true,
        data: { ...question(Number(qid.slice(-2)), 'DRAFT'), publication_status: 'CONFIRMED' },
      }),
    );
    render(<Screen />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await user.click(within(rows()[1] as HTMLElement).getByRole('button', { name: '보관 해제' }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(setQuestionStatusAction).toHaveBeenCalledWith(
      WS,
      id(2),
      '88888888-8888-4888-8888-000000000002',
      'CONFIRMED',
    );
    await user.click(within(rows()[0] as HTMLElement).getByRole('button', { name: '확정' }));
    expect(
      await screen.findByRole('heading', { name: '보관하거나 초안인 문제가 없습니다' }),
    ).toBeInTheDocument();
  });

  it.each([
    ['viewer', '보기 권한으로는 문제를 볼 수만 있습니다.'],
    ['archived', '보관된 Workspace는 읽기 전용입니다.'],
  ] as const)('QOV-01-AC15 a %s reads without write controls', async (readOnly, text) => {
    listInactiveQuestionsAction.mockResolvedValue(
      page([question(1, 'DRAFT'), question(2, 'ARCHIVED')]),
    );
    render(<Screen readOnly={readOnly} />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '보관 해제' })).toBeNull();
    expect(screen.queryByRole('button', { name: '확정' })).toBeNull();
  });

  it('QOV-01-AC15 a failed list says why and retries', async () => {
    const user = userEvent.setup();
    listInactiveQuestionsAction
      .mockResolvedValueOnce({
        ok: false,
        kind: 'unavailable',
        message: '잠시 후 다시 시도해 주세요.',
      })
      .mockResolvedValueOnce(page([]));
    render(<Screen />);
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: '다시 시도' }));
    expect(
      await screen.findByRole('heading', { name: '보관하거나 초안인 문제가 없습니다' }),
    ).toBeInTheDocument();
  });
});
