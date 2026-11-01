// @vitest-environment jsdom
// UX4 (2026-10-21): the home header's `문제` menu (직접 추가 / 변형 출제, keyboard reachable, for
// editors only). UX7-BANK retired its 전체 문제 link with the page, and 직접 추가 now opens the
// 문제 등록 dialog on the home (QOV-01-AC12); UX7-DOCS merged PDF 관리 into 문서 관리
// (DOC-01-AC09), which leaves viewers without a menu.
import './dom-setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const { QuestionMenu } = await import('../src/components/workspaces/question-menu');

function menu(canEdit: boolean) {
  const handlers = { onCreate: vi.fn(), onGenerate: vi.fn() };
  render(<QuestionMenu canEdit={canEdit} {...handlers} />);
  return handlers;
}

describe('home `문제` menu', () => {
  it('QOV-01-AC11 offers 직접 추가 and 변형 출제 to editors and opens each', async () => {
    const user = userEvent.setup();
    const handlers = menu(true);
    const trigger = screen.getByRole('button', { name: '문제' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    await user.click(trigger);
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['직접 추가', '변형 출제']);
    await user.click(screen.getByRole('menuitem', { name: '직접 추가' }));
    // UX7-BANK: the 문제 등록 dialog opens on the home once focus is back on the trigger.
    await waitFor(() => expect(handlers.onCreate).toHaveBeenCalledTimes(1));
    expect(trigger).toHaveFocus();

    // Keyboard: open with Enter, move with the arrow keys, choose with Enter.
    trigger.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(handlers.onGenerate).toHaveBeenCalledTimes(1));
    // The dialog opens after the menu returned focus to its trigger.
    expect(trigger).toHaveFocus();
  });

  it('QOV-01-AC11 gives viewers no 문제 menu (UX7-DOCS), and nobody 전체 문제 (UX7-BANK)', () => {
    menu(false);
    expect(screen.queryByRole('button', { name: '문제' })).toBeNull();
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(screen.queryByRole('link', { name: '전체 문제' })).toBeNull();
  });
});
