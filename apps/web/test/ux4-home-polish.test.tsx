// @vitest-environment jsdom
// UX4 (2026-10-21): the home header's `문제` menu (PDF 관리 / 직접 추가 / 변형 출제, keyboard
// reachable, authoring items for editors only). UX7-BANK retired its 전체 문제 link with the page,
// and 직접 추가 now opens the 문제 등록 dialog on the home (QOV-01-AC12).
import './dom-setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const { QuestionMenu } = await import('../src/components/workspaces/question-menu');

function menu(canEdit: boolean) {
  const handlers = { onPdfs: vi.fn(), onCreate: vi.fn(), onGenerate: vi.fn() };
  render(<QuestionMenu canEdit={canEdit} {...handlers} />);
  return handlers;
}

describe('home `문제` menu', () => {
  it('QOV-01-AC11 offers PDF 관리, 직접 추가 and 변형 출제 to editors and opens each', async () => {
    const user = userEvent.setup();
    const handlers = menu(true);
    const trigger = screen.getByRole('button', { name: '문제' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    await user.click(trigger);
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['PDF 관리', '직접 추가', '변형 출제']);
    await user.click(screen.getByRole('menuitem', { name: '직접 추가' }));
    // UX7-BANK: the 문제 등록 dialog opens on the home once focus is back on the trigger.
    await waitFor(() => expect(handlers.onCreate).toHaveBeenCalledTimes(1));
    expect(trigger).toHaveFocus();

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

  it('QOV-01-AC11 shows viewers PDF 관리 only, and nobody 전체 문제 (UX7-BANK)', async () => {
    const user = userEvent.setup();
    menu(false);
    await user.click(screen.getByRole('button', { name: '문제' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['PDF 관리']);
    expect(screen.queryByRole('menuitem', { name: '전체 문제' })).toBeNull();
    expect(screen.queryByRole('link', { name: '전체 문제' })).toBeNull();
  });
});
