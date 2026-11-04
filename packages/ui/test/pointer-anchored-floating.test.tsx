// design-system §5.4 PointerAnchoredFloating (CHNOTE-02 footnote preview): hover opens after the
// tooltip delay as a role=tooltip describing the trigger, keyboard focus opens at once, a touch tap
// opens a named dialog instead of activating the trigger, and it closes after the pointer leaves,
// on Escape and on scroll. Inside a modal dialog (CHNOTE-02 note panel) the keyboard preview stays
// open on the focused trigger.
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  FloatingSidePanel,
  POINTER_FLOATING_CLOSE_MS,
  PointerAnchoredFloating,
  TOOLTIP_DELAY_MS,
} from '../src';

function Footnote({ onClick }: { onClick?: () => void }) {
  return (
    <PointerAnchoredFloating
      label="문제 미리보기"
      openOnTap
      content={({ mode }) => (
        <>
          <p>3장 12번 · 객관식</p>
          {mode === 'tap' ? <button type="button">문제 열기</button> : null}
        </>
      )}
    >
      <a
        href="#q"
        onClick={(event) => {
          event.preventDefault();
          onClick?.();
        }}
      >
        [1]
      </a>
    </PointerAnchoredFloating>
  );
}

describe('PointerAnchoredFloating', () => {
  it('opens on hover after the delay as a tooltip and closes after the pointer leaves', () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<Footnote />);
      const link = screen.getByRole('link', { name: '[1]' });
      fireEvent.pointerEnter(link, { pointerType: 'mouse', clientX: 40, clientY: 50 });
      fireEvent.pointerMove(link, { pointerType: 'mouse', clientX: 44, clientY: 52 });
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 10);
      });
      expect(screen.queryByRole('tooltip')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(20);
      });
      const tip = screen.getByRole('tooltip');
      expect(tip).toHaveTextContent('3장 12번 · 객관식');
      expect(link).toHaveAttribute('aria-describedby', tip.id);
      expect(screen.queryByRole('button', { name: '문제 열기' })).toBeNull();

      fireEvent.pointerLeave(link, { pointerType: 'mouse' });
      // Moving into the floating keeps it.
      fireEvent.pointerEnter(tip, { pointerType: 'mouse' });
      act(() => {
        vi.advanceTimersByTime(POINTER_FLOATING_CLOSE_MS + 10);
      });
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
      fireEvent.pointerLeave(tip, { pointerType: 'mouse' });
      act(() => {
        vi.advanceTimersByTime(POINTER_FLOATING_CLOSE_MS + 10);
      });
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(link).not.toHaveAttribute('aria-describedby');
      unmount();
      act(() => {
        vi.runOnlyPendingTimers();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens at once for keyboard focus and closes on Escape, blur and scroll', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Footnote />
        <button type="button">다음</button>
      </>,
    );
    await user.tab();
    expect(screen.getByRole('link', { name: '[1]' })).toHaveFocus();
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.tab();
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.tab({ shift: true });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await user.tab();
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.tab({ shift: true });
    fireEvent.scroll(window);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a touch tap opens a named dialog instead of following the link; a mouse click follows it', () => {
    const onClick = vi.fn();
    render(<Footnote onClick={onClick} />);
    const link = screen.getByRole('link', { name: '[1]' });
    fireEvent.pointerDown(link, { pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.click(link);
    expect(onClick).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: '문제 미리보기' });
    expect(dialog).toContainElement(screen.getByRole('button', { name: '문제 열기' }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.pointerDown(link, { pointerType: 'mouse' });
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('inside a modal dialog, keyboard focus on the trigger keeps the preview open', async () => {
    const user = userEvent.setup();
    render(
      <FloatingSidePanel defaultOpen title="정리 노트" closeLabel="닫기">
        <button type="button">처음</button>
        <Footnote />
      </FloatingSidePanel>,
    );
    const link = screen.getByRole('link', { name: '[1]' });
    for (let i = 0; i < 4 && document.activeElement !== link; i++) await user.tab();
    expect(link).toHaveFocus();
    const tip = screen.getByRole('tooltip');
    expect(link).toHaveAttribute('aria-describedby', tip.id);
  });
});
