// @vitest-environment jsdom
// UX4 (2026-10-21): the home header's `문제` menu (PDF 관리 / 직접 추가 / 변형 출제, keyboard
// reachable, authoring items for editors only), the bank's one-shot `?create=1` that opens the
// 문제 등록 editor (the menu's 직접 추가), and QBANK-01-AC06: the bank's collapsed search/filters,
// its empty-state-only actions and "PDF 가져오기" opening the shared 문제 PDF 관리 dialog.
import './dom-setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@quiz/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentSummary } from '../src/lib/documents/data';
import {
  bankCreatePath,
  DEFAULT_FILTERS,
  wantsCreate,
  type BankFilters,
} from '../src/lib/questions/filters';
import type { Question } from '../src/lib/questions/form';

vi.mock('next/navigation', () => ({
  usePathname: () => '/workspaces/ws/questions/bank',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('../src/lib/questions/actions', () => ({
  listQuestionsAction: vi.fn(),
  deleteQuestionAction: vi.fn(),
  setQuestionStatusAction: vi.fn(),
  createQuestionAction: vi.fn(),
  updateQuestionAction: vi.fn(),
  getQuestionAction: vi.fn(),
  getQuestionRevisionAction: vi.fn(),
}));

const { QuestionMenu } = await import('../src/components/workspaces/question-menu');
const { QuestionBank } = await import('../src/components/questions/question-bank');

const WS = '55555555-5555-4555-8555-555555555555';

function menu(canEdit: boolean) {
  const handlers = { onPdfs: vi.fn(), onCreate: vi.fn(), onGenerate: vi.fn() };
  render(<QuestionMenu canEdit={canEdit} {...handlers} />);
  return handlers;
}

describe('home `문제` menu', () => {
  it('offers PDF 관리, 직접 추가 and 변형 출제 to editors and opens each', async () => {
    const user = userEvent.setup();
    const handlers = menu(true);
    const trigger = screen.getByRole('button', { name: '문제' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    await user.click(trigger);
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['PDF 관리', '직접 추가', '변형 출제']);
    await user.click(screen.getByRole('menuitem', { name: '직접 추가' }));
    expect(handlers.onCreate).toHaveBeenCalledTimes(1);

    // Keyboard: open with Enter, move with the arrow keys, choose with Enter.
    trigger.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() => expect(handlers.onGenerate).toHaveBeenCalledTimes(1));
    // The dialog opens after the menu returned focus to its trigger.
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'PDF 관리' }));
    await waitFor(() => expect(handlers.onPdfs).toHaveBeenCalledTimes(1));
  });

  it('shows viewers only PDF 관리', async () => {
    const user = userEvent.setup();
    menu(false);
    await user.click(screen.getByRole('button', { name: '문제' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['PDF 관리']);
  });
});

describe('bank `?create=1`', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', `${bankCreatePath(WS)}&type=MCQ`);
  });

  it('builds and reads the one-shot parameter', () => {
    expect(bankCreatePath(WS)).toBe(`/workspaces/${WS}/questions/bank?create=1`);
    expect(wantsCreate(new URLSearchParams('create=1'))).toBe(true);
    expect(wantsCreate({ create: '0' })).toBe(false);
  });

  it('opens the 문제 등록 editor on arrival and drops the parameter from the URL', async () => {
    render(
      <ToastProvider>
        <QuestionBank
          workspaceId={WS}
          readOnly={null}
          filters={DEFAULT_FILTERS}
          items={[]}
          nextCursor={null}
          failure={null}
          chapters={[]}
          documents={[]}
          openCreate
        />
      </ToastProvider>,
    );
    expect(await screen.findByRole('dialog', { name: '문제 등록' })).toBeInTheDocument();
    expect(window.location.search).toBe('?type=MCQ');
  });

  it('ignores it for read-only banks', () => {
    render(
      <ToastProvider>
        <QuestionBank
          workspaceId={WS}
          readOnly="viewer"
          filters={DEFAULT_FILTERS}
          items={[]}
          nextCursor={null}
          failure={null}
          chapters={[]}
          documents={[]}
          openCreate
        />
      </ToastProvider>,
    );
    expect(screen.queryByRole('dialog', { name: '문제 등록' })).toBeNull();
  });
});

const question = {
  id: '44444444-4444-4444-8444-000000000001',
  workspace_id: WS,
  question_type: 'MCQ',
  publication_status: 'CONFIRMED',
  origin: 'manual',
  chapter_id: null,
  chapter: null,
  question_number: null,
  revision: {
    id: '11111111-1111-4111-8111-000000000001',
    version: 1,
    stem: '첫 문제',
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
} as Question;

const paper = {
  id: '66666666-6666-4666-8666-000000000001',
  title: '모의고사 1회',
  document_type: 'question_paper',
  status: 'ready',
  active_revision_id: '77777777-7777-4777-8777-000000000001',
  created_at: '2026-10-17T00:00:00Z',
  updated_at: '2026-10-17T00:00:00Z',
} as unknown as DocumentSummary;
const book = {
  ...paper,
  id: '66666666-6666-4666-8666-000000000002',
  title: '교과서',
  document_type: 'book',
} as DocumentSummary;

function bank(items: Question[], filters: BankFilters = DEFAULT_FILTERS) {
  render(
    <ToastProvider>
      <main>
        <QuestionBank
          workspaceId={WS}
          readOnly={null}
          filters={filters}
          items={items}
          nextCursor={null}
          failure={null}
          chapters={[]}
          documents={[]}
          questionPdfs={{ documents: [paper, book], failed: false }}
        />
      </main>
    </ToastProvider>,
  );
}

describe('QBANK-01-AC06 bank polish', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', `/workspaces/${WS}/questions/bank`);
  });

  it('keeps the search and filters behind a collapsed toggle', async () => {
    const user = userEvent.setup();
    bank([question]);
    const toggle = screen.getByRole('button', { name: '검색·필터' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle.querySelector('svg')).not.toBeNull();
    expect(screen.queryByRole('searchbox', { name: '문제 검색' })).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByRole('group', { name: '검색·필터' });
    expect(toggle).toHaveAttribute('aria-controls', group.id);
    expect(screen.getByRole('searchbox', { name: '문제 검색' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: '유형' })).toBeVisible();
  });

  it('says a collapsed filter applies', () => {
    bank([question], { ...DEFAULT_FILTERS, type: 'ESSAY' });
    expect(screen.getByText('검색·필터 적용 중')).toBeInTheDocument();
  });

  it('has the header actions only while questions exist', () => {
    bank([]);
    expect(screen.getByRole('heading', { name: '등록된 문제가 없습니다' })).toBeInTheDocument();
    // The empty state's own pair only.
    expect(screen.getAllByRole('button', { name: 'PDF 가져오기' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '문제 등록' })).toBeNull();
    expect(screen.getByRole('button', { name: '문제 직접 등록' })).toBeInTheDocument();
  });

  it('opens the 문제 PDF 관리 dialog with the question papers only', async () => {
    const user = userEvent.setup();
    bank([question]);
    expect(screen.getByRole('button', { name: '문제 등록' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'PDF 가져오기' }));
    const dialog = await screen.findByRole('dialog', { name: '문제 PDF 관리' });
    expect(dialog).not.toHaveAttribute('aria-modal', 'true');
    const list = within(dialog).getByRole('list', { name: '문제 PDF 목록' });
    expect(within(list).getByText('모의고사 1회')).toBeInTheDocument();
    expect(within(list).queryByText('교과서')).toBeNull();
    // UX4: the Dropzone's "PDF 선택" is the only way in; no separate "PDF 가져오기" in the dialog.
    expect(within(dialog).getByRole('button', { name: 'PDF 선택' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: 'PDF 가져오기' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'PDF 가져오기' })).toBeNull();
  });
});
