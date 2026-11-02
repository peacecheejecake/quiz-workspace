// @vitest-environment jsdom
// UX4 (2026-10-21): the home header's `문제` menu (직접 추가, keyboard reachable, for editors
// only; its 변형 출제 was retired with QGEN-01 by QGEN-RM). UX7-BANK retired its 전체 문제 link
// with the page, and 직접 추가 now opens the 문제 등록 dialog on the home (QOV-01-AC12); UX7-DOCS merged PDF 관리 into 문서 관리
// (DOC-01-AC09). UX7-DOCS-2 keeps the button for viewers and archived workspaces, with both items
// disabled and the reason in text. UX7-BANK-2 adds 보관·초안 문제, enabled for every member.
// UX7-DEDUP adds 중복 문제 정리, editor-only like 직접 추가 (QOV-01-AC16). QVIEW-W adds
// 문제 풀기 (the range run, QVIEW-01), enabled for every member like 보관·초안 문제. MOCK-W adds
// 모의고사 (MOCK-01) between them, enabled for every member too.
import './dom-setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { QuestionMenuReadOnly } from '../src/components/workspaces/question-menu';

const { QuestionMenu } = await import('../src/components/workspaces/question-menu');

function menu(readOnly: QuestionMenuReadOnly) {
  const handlers = {
    onCreate: vi.fn(),
    onDuplicates: vi.fn(),
    onInactive: vi.fn(),
    onMockExams: vi.fn(),
    onPractice: vi.fn(),
  };
  render(<QuestionMenu readOnly={readOnly} {...handlers} />);
  return handlers;
}

describe('home `문제` menu', () => {
  it('QOV-01-AC11 offers 직접 추가 and 중복 문제 정리 to editors, then 모의고사, and opens each', async () => {
    const user = userEvent.setup();
    const handlers = menu(null);
    const trigger = screen.getByRole('button', { name: '문제' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    await user.click(trigger);
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual([
      '직접 추가',
      '중복 문제 정리',
      '보관·초안 문제',
      '모의고사',
      '문제 풀기',
    ]);
    await user.click(screen.getByRole('menuitem', { name: '직접 추가' }));
    // UX7-BANK: the 문제 등록 dialog opens on the home once focus is back on the trigger.
    await waitFor(() => expect(handlers.onCreate).toHaveBeenCalledTimes(1));
    expect(trigger).toHaveFocus();

    // Keyboard: open with Enter, move with the arrow keys, choose with Enter.
    trigger.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(handlers.onDuplicates).toHaveBeenCalledTimes(1));
    // The dialog opens after the menu returned focus to its trigger.
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: '보관·초안 문제' }));
    await waitFor(() => expect(handlers.onInactive).toHaveBeenCalledTimes(1));

    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: '모의고사' }));
    await waitFor(() => expect(handlers.onMockExams).toHaveBeenCalledTimes(1));

    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: '문제 풀기' }));
    await waitFor(() => expect(handlers.onPractice).toHaveBeenCalledTimes(1));
    expect(trigger).toHaveFocus();
  });

  it.each([
    ['viewer', '편집 권한이 있어야 사용할 수 있습니다'],
    ['archived', '보관된 Workspace는 읽기 전용입니다'],
  ] as const)(
    'QOV-01-AC11 keeps the 문제 menu for %s with the editor items disabled and the reason (UX7-DOCS-2)',
    async (readOnly, reason) => {
      const user = userEvent.setup();
      const handlers = menu(readOnly);
      const trigger = screen.getByRole('button', { name: '문제' });
      await user.click(trigger);
      const menuEl = await screen.findByRole('menu', { name: '문제' });
      expect(menuEl).toHaveTextContent(reason);
      expect(menuEl).toHaveAccessibleDescription(reason);
      const all = screen.getAllByRole('menuitem');
      expect(all.map((item) => item.textContent)).toEqual([
        '직접 추가',
        '중복 문제 정리',
        '보관·초안 문제',
        '모의고사',
        '문제 풀기',
      ]);
      const items = all.slice(0, 2);
      for (const item of items) {
        expect(item).toHaveAttribute('aria-disabled', 'true');
        expect(item).toHaveAccessibleDescription(reason);
        await user.click(item);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(handlers.onCreate).not.toHaveBeenCalled();
      expect(handlers.onDuplicates).not.toHaveBeenCalled();
      expect(screen.queryByRole('link', { name: '전체 문제' })).toBeNull();
      // UX7-BANK-2: 보관·초안 문제 is readable, so it stays enabled and opens the dialog.
      const inactive = screen.getByRole('menuitem', { name: '보관·초안 문제' });
      expect(inactive).not.toHaveAttribute('aria-disabled');
      await user.click(inactive);
      await waitFor(() => expect(handlers.onInactive).toHaveBeenCalledTimes(1));
      // QVIEW-01: 문제 풀기 is a personal practice: enabled, no reason attached.
      await user.click(trigger);
      const practice = screen.getByRole('menuitem', { name: '문제 풀기' });
      expect(practice).not.toHaveAttribute('aria-disabled');
      expect(practice).not.toHaveAccessibleDescription(reason);
      await user.click(practice);
      await waitFor(() => expect(handlers.onPractice).toHaveBeenCalledTimes(1));
      // MOCK-01: every member lists and practises mock exams.
      await user.click(trigger);
      const mock = screen.getByRole('menuitem', { name: '모의고사' });
      expect(mock).not.toHaveAttribute('aria-disabled');
      expect(mock).not.toHaveAccessibleDescription(reason);
      await user.click(mock);
      await waitFor(() => expect(handlers.onMockExams).toHaveBeenCalledTimes(1));
    },
  );
});
