// design-system §5.6 paired dialog (QSRC-01-AC03/AC04): a modal FloatingSidePanel opened from an
// open question panel. Placement is CSS (checked by the Storybook visual spec); here: the data
// attributes that drive it, usePairedSheet at both sides of 868px, and the close order.
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, FloatingSidePanel, usePairedSheet } from '../src';

function mockViewport(initial: number) {
  let width = initial;
  const listeners = new Set<() => void>();
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return width < 868 && query === '(width < 868px)';
        },
        media: query,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      }) as unknown as MediaQueryList,
  );
  return {
    resize(next: number) {
      width = next;
      act(() => listeners.forEach((fn) => fn()));
    },
  };
}

function Probe() {
  return <output>{usePairedSheet() ? 'sheet' : 'beside'}</output>;
}

describe('usePairedSheet', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [767, 'sheet'],
    [820, 'sheet'],
    [867, 'sheet'],
    [868, 'beside'],
    [1280, 'beside'],
  ])('at %ipx the paired dialog is %s', (width, expected) => {
    mockViewport(width);
    render(<Probe />);
    expect(screen.getByRole('status')).toHaveTextContent(expected);
  });

  it('follows the viewport', () => {
    const viewport = mockViewport(900);
    render(<Probe />);
    expect(screen.getByRole('status')).toHaveTextContent('beside');
    viewport.resize(800);
    expect(screen.getByRole('status')).toHaveTextContent('sheet');
    viewport.resize(868);
    expect(screen.getByRole('status')).toHaveTextContent('beside');
  });
});

function Pair({ onPairedClose }: { onPairedClose?: () => void }) {
  const [paired, setPaired] = useState(false);
  return (
    <FloatingSidePanel defaultOpen title="문제 3">
      <Button onClick={() => setPaired(true)}>문제 원문 보기</Button>
      <FloatingSidePanel
        paired
        title="문제 원문"
        open={paired}
        onOpenChange={(next) => {
          setPaired(next);
          if (!next) onPairedClose?.();
        }}
      >
        <p>영역</p>
      </FloatingSidePanel>
    </FloatingSidePanel>
  );
}

describe('FloatingSidePanel paired', () => {
  it('sits at the start edge as a sheet-capable modal above the open panel', async () => {
    const user = userEvent.setup();
    render(<Pair />);
    await user.click(screen.getByRole('button', { name: '문제 원문 보기' }));
    const paired = await screen.findByRole('dialog', { name: '문제 원문' });
    const base = document.querySelector<HTMLElement>('.qz-panel[data-side="end"]');
    if (!base) throw new Error('missing question panel');
    expect(paired).toHaveAttribute('data-paired');
    expect(paired).toHaveAttribute('data-side', 'start');
    expect(paired).toHaveAttribute('data-mobile-layout', 'full');
    expect(paired).toHaveAttribute('aria-modal', 'true');
    expect(base).not.toHaveAttribute('data-paired');
    expect(base).toHaveAttribute('data-side', 'end');
    expect(Number(paired.dataset.layerRank)).toBeGreaterThan(Number(base.dataset.layerRank));
  });

  it('Escape closes only the paired dialog and returns focus to the opener', async () => {
    const user = userEvent.setup();
    const onPairedClose = vi.fn();
    render(<Pair onPairedClose={onPairedClose} />);
    const opener = screen.getByRole('button', { name: '문제 원문 보기' });
    await user.click(opener);
    await screen.findByRole('dialog', { name: '문제 원문' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '문제 원문' })).toBeNull());
    expect(onPairedClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: '문제 3' })).toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
    // The next Escape closes the question panel.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '문제 3' })).toBeNull());
  });

  it('닫기 closes only the paired dialog and returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<Pair />);
    const opener = screen.getByRole('button', { name: '문제 원문 보기' });
    await user.click(opener);
    const paired = await screen.findByRole('dialog', { name: '문제 원문' });
    const close = paired.querySelector<HTMLButtonElement>('button[aria-label="닫기"]');
    if (!close) throw new Error('missing close button');
    await user.click(close);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '문제 원문' })).toBeNull());
    expect(screen.getByRole('dialog', { name: '문제 3' })).toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('a backdrop click closes only the paired dialog', async () => {
    const user = userEvent.setup();
    render(<Pair />);
    await user.click(screen.getByRole('button', { name: '문제 원문 보기' }));
    await screen.findByRole('dialog', { name: '문제 원문' });
    const backdrops = document.querySelectorAll<HTMLElement>('.qz-backdrop');
    expect(backdrops).toHaveLength(2);
    const top = backdrops[1];
    if (!top) throw new Error('missing paired backdrop');
    await user.click(top);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '문제 원문' })).toBeNull());
    expect(screen.getByRole('dialog', { name: '문제 3' })).toBeInTheDocument();
  });

  it('a plain panel is unchanged: end edge, its own mobile layout, no paired marker', () => {
    render(
      <FloatingSidePanel defaultOpen title="패널" mobileLayout="sheet">
        내용
      </FloatingSidePanel>,
    );
    const dialog = screen.getByRole('dialog', { name: '패널' });
    expect(dialog).not.toHaveAttribute('data-paired');
    expect(dialog).toHaveAttribute('data-side', 'end');
    expect(dialog).toHaveAttribute('data-mobile-layout', 'sheet');
  });
});
