// design-system §5.6 PreviewTooltip (QSRC-01-AC02): hover / :focus-visible / 500 ms touch
// long-press open it; a long-press swallows the release click, a short tap clicks; a touch outside
// or Escape closes only the tooltip and the dismissing tap is consumed.
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingSidePanel, PREVIEW_LONG_PRESS_MS, PreviewTooltip } from '../src';

const touch = { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: 10, clientY: 10 };

/** The E2E helper's sequence: pointerdown(touch) -> wait -> pointerup(touch) -> click. */
async function press(target: Element, ms: number) {
  fireEvent.pointerDown(target, touch);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  fireEvent.pointerUp(target, touch);
  fireEvent.click(target, { detail: 1 });
}

function Harness({ onClick, onOpenChange }: { onClick: () => void; onOpenChange?: () => void }) {
  return (
    <>
      <button type="button">바깥</button>
      <PreviewTooltip
        content={<span role="status">원문을 불러오는 중입니다</span>}
        onOpenChange={onOpenChange}
      >
        <button type="button" onClick={onClick}>
          문제 원문 보기
        </button>
      </PreviewTooltip>
    </>
  );
}

describe('PreviewTooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on hover after the delay and describes the trigger; leaving closes it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness onClick={() => undefined} />);
    const trigger = screen.getByRole('button', { name: '문제 원문 보기' });
    await user.hover(trigger);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('원문을 불러오는 중입니다');
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
    await user.unhover(trigger);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(trigger).not.toHaveAttribute('aria-describedby');
  });

  it('opens on keyboard focus and closes on Escape without closing the panel under it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <FloatingSidePanel defaultOpen title="문제 3">
        <Harness onClick={() => undefined} />
      </FloatingSidePanel>,
    );
    await user.tab();
    await user.tab();
    const trigger = screen.getByRole('button', { name: '문제 원문 보기' });
    for (let i = 0; i < 6 && document.activeElement !== trigger; i += 1) await user.tab();
    expect(trigger).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.getByRole('dialog', { name: '문제 3' })).toBeInTheDocument();
    // The next Escape closes the panel.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '문제 3' })).toBeNull();
  });

  it('a long-press opens the tooltip after 500 ms and swallows the release click', async () => {
    const onClick = vi.fn();
    render(<Harness onClick={onClick} />);
    const trigger = screen.getByRole('button', { name: '문제 원문 보기' });
    fireEvent.pointerDown(trigger, touch);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_LONG_PRESS_MS - 50);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.pointerUp(trigger, touch);
    fireEvent.click(trigger, { detail: 1 });
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('the E2E helper sequence (pointerdown, wait, pointerup, click) behaves the same', async () => {
    const onClick = vi.fn();
    render(<Harness onClick={onClick} />);
    await press(screen.getByRole('button', { name: '문제 원문 보기' }), 650);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('only the first click after a long-press is swallowed', async () => {
    const onClick = vi.fn();
    render(<Harness onClick={onClick} />);
    const trigger = screen.getByRole('button', { name: '문제 원문 보기' });
    await press(trigger, 650);
    expect(onClick).not.toHaveBeenCalled();
    await tap(trigger);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a long-press whose release click never arrives does not eat a later activation', async () => {
    const onClick = vi.fn();
    render(<Harness onClick={onClick} />);
    const trigger = screen.getByRole('button', { name: '문제 원문 보기' });
    fireEvent.pointerDown(trigger, touch);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650);
    });
    fireEvent.pointerUp(trigger, touch);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    fireEvent.click(trigger, { detail: 0 });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a short tap opens no tooltip and passes the click through', async () => {
    const onClick = vi.fn();
    render(<Harness onClick={onClick} />);
    await press(screen.getByRole('button', { name: '문제 원문 보기' }), 60);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('tooltip')).toBeNull();
    // The 500 ms timer of that tap was cancelled by the release.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a touch that moves away is a scroll, not a long-press', async () => {
    render(<Harness onClick={() => undefined} />);
    const trigger = screen.getByRole('button', { name: '문제 원문 보기' });
    fireEvent.pointerDown(trigger, touch);
    fireEvent.pointerMove(trigger, { ...touch, clientY: 60 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a touch outside closes only the tooltip and consumes that tap', async () => {
    const onClick = vi.fn();
    const onOutside = vi.fn();
    render(
      <FloatingSidePanel defaultOpen title="문제 3">
        <Harness onClick={onClick} />
        <button type="button" onClick={onOutside}>
          패널 안 버튼
        </button>
      </FloatingSidePanel>,
    );
    await press(screen.getByRole('button', { name: '문제 원문 보기' }), 650);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    const outside = screen.getByRole('button', { name: '패널 안 버튼' });
    fireEvent.pointerDown(outside, { ...touch, pointerId: 8 });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.pointerUp(outside, { ...touch, pointerId: 8 });
    fireEvent.click(outside, { detail: 1 });
    expect(onOutside).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '문제 3' })).toBeInTheDocument();
    // The tap after it is an ordinary one.
    fireEvent.click(outside, { detail: 1 });
    expect(onOutside).toHaveBeenCalledTimes(1);
  });

  it('a mouse press outside closes the tooltip but does not consume the click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onOutside = vi.fn();
    render(
      <>
        <button type="button" onClick={onOutside}>
          바깥 버튼
        </button>
        <Harness onClick={() => undefined} />
      </>,
    );
    await user.hover(screen.getByRole('button', { name: '문제 원문 보기' }));
    await screen.findByRole('tooltip');
    await user.click(screen.getByRole('button', { name: '바깥 버튼' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(onOutside).toHaveBeenCalledTimes(1);
  });

  it('a click closes the tooltip, and focus coming back to the trigger does not reopen it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    function WithDialog() {
      const [open, setOpen] = useState(false);
      return (
        <FloatingSidePanel defaultOpen title="문제 3">
          <PreviewTooltip content="미리보기">
            <button type="button" onClick={() => setOpen(true)}>
              문제 원문 보기
            </button>
          </PreviewTooltip>
          <FloatingSidePanel paired title="문제 원문" open={open} onOpenChange={setOpen}>
            영역
          </FloatingSidePanel>
        </FloatingSidePanel>
      );
    }
    render(<WithDialog />);
    const trigger = screen.getByRole('button', { name: '문제 원문 보기' });
    for (let i = 0; i < 6 && document.activeElement !== trigger; i += 1) await user.tab();
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    await screen.findByRole('dialog', { name: '문제 원문' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '문제 원문' })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('reports open and close to the caller (lazy loading starts on the first open)', async () => {
    const onOpenChange = vi.fn();
    render(<Harness onClick={() => undefined} onOpenChange={onOpenChange} />);
    const trigger = screen.getByRole('button', { name: '문제 원문 보기' });
    await press(trigger, 650);
    expect(onOpenChange).toHaveBeenLastCalledWith(true, 'touch');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenLastCalledWith(false, 'touch');
  });
});

async function tap(target: Element) {
  fireEvent.pointerDown(target, { ...touch, pointerId: 9 });
  fireEvent.pointerUp(target, { ...touch, pointerId: 9 });
  fireEvent.click(target, { detail: 1 });
}
