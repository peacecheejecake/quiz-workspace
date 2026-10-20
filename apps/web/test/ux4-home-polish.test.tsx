// @vitest-environment jsdom
// UX4 (2026-10-21): the home header's `문제` menu (PDF 관리 / 직접 추가 / 변형 출제, keyboard
// reachable, authoring items for editors only) and the bank's one-shot `?create=1` that opens the
// 문제 등록 editor (the menu's 직접 추가).
import './dom-setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@quiz/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bankCreatePath, DEFAULT_FILTERS, wantsCreate } from '../src/lib/questions/filters';

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
