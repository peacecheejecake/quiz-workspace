import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitView, type SplitViewOrientation, type SplitViewProps } from '../src';
import { splitRange } from '../src/layout/SplitView';

const LABEL = '원본과 변환본 크기 조절';
const valueText = (r: number) => `원본 ${r}%, 변환본 ${100 - r}%`;

/** Lays both panes out as `size` px together (jsdom has no layout): split by the grid template. */
function mockPaneSpace(size: number) {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const half = this.classList.contains('pane') ? size / 2 : 0;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: half,
      bottom: half,
      width: half,
      height: half,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

function Controlled(
  props: Partial<SplitViewProps> & { initial?: number; onCommit?: (r: number) => void },
) {
  const { initial = 50, onCommit, ...rest } = props;
  const [ratio, setRatio] = useState(initial);
  return (
    <SplitView
      separatorLabel={LABEL}
      valueText={valueText}
      ratio={ratio}
      onRatioChange={setRatio}
      onRatioCommit={onCommit}
      {...rest}
    >
      <section aria-label="PDF 원본">원본</section>
      <section aria-label="변환본 텍스트">변환본</section>
    </SplitView>
  );
}

const separator = () => screen.getByRole('separator', { name: LABEL });
const valueNow = () => Number(separator().getAttribute('aria-valuenow'));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SplitView separator ARIA', () => {
  it.each<[SplitViewOrientation, string]>([
    ['horizontal', 'vertical'],
    ['vertical', 'horizontal'],
  ])(
    '%s split: focusable separator with aria-orientation %s and the value attributes',
    (o, aria) => {
      render(<Controlled orientation={o} initial={60} />);
      const sep = separator();
      expect(sep).toHaveAttribute('tabindex', '0');
      expect(sep).toHaveAttribute('aria-orientation', aria);
      expect(sep).toHaveAttribute('aria-valuenow', '60');
      expect(sep).toHaveAttribute('aria-valuemin', '20');
      expect(sep).toHaveAttribute('aria-valuemax', '80');
      expect(sep).toHaveAttribute('aria-valuetext', '원본 60%, 변환본 40%');
      // aria-controls names the first pane, which holds the first child.
      const first = document.getElementById(sep.getAttribute('aria-controls') ?? '');
      expect(first).toContainElement(screen.getByRole('region', { name: 'PDF 원본' }));
      expect(sep).toHaveClass('qz-focus-ring');
    },
  );

  it('lays the panes out by the ratio on the split axis', () => {
    const { container, rerender } = render(<Controlled initial={60} />);
    const root = container.querySelector<HTMLElement>('.qz-split');
    expect(root?.style.gridTemplateColumns).toBe(
      'minmax(0, 60fr) var(--qz-split-gutter) minmax(0, 40fr)',
    );
    rerender(<Controlled initial={60} orientation="vertical" />);
    expect(root?.style.gridTemplateRows).toBe(
      'minmax(0, 60fr) var(--qz-split-gutter) minmax(0, 40fr)',
    );
  });

  it('clamps an out-of-range ratio for display without reporting a change', () => {
    const onRatioChange = vi.fn();
    render(
      <SplitView separatorLabel={LABEL} ratio={5} onRatioChange={onRatioChange}>
        <p>가</p>
        <p>나</p>
      </SplitView>,
    );
    expect(valueNow()).toBe(20);
    expect(onRatioChange).not.toHaveBeenCalled();
  });

  it('single-pane modes keep the hidden pane mounted and hide the separator', () => {
    const { rerender } = render(<Controlled visible="first" />);
    expect(screen.queryByRole('separator')).toBeNull();
    const text = screen.getByText('변환본');
    expect(text.closest('[hidden]')).not.toBeNull();
    rerender(<Controlled visible="second" />);
    expect(screen.getByText('변환본').closest('[hidden]')).toBeNull();
    expect(screen.getByText('원본').closest('[hidden]')).not.toBeNull();
    // Same node: the pane was not remounted.
    expect(screen.getByText('변환본')).toBe(text);
    rerender(<Controlled visible="both" />);
    expect(separator()).toBeVisible();
  });
});

describe('SplitView keyboard', () => {
  it('horizontal: ←/→ ±5, Home/End min/max, Enter resets; ↑/↓ are ignored', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Controlled onCommit={onCommit} />);
    separator().focus();
    await user.keyboard('{ArrowRight}');
    expect(valueNow()).toBe(55);
    expect(onCommit).toHaveBeenLastCalledWith(55);
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(valueNow()).toBe(45);
    await user.keyboard('{ArrowDown}{ArrowUp}');
    expect(valueNow()).toBe(45);
    await user.keyboard('{End}');
    expect(valueNow()).toBe(80);
    await user.keyboard('{ArrowRight}');
    expect(valueNow()).toBe(80);
    await user.keyboard('{Home}');
    expect(valueNow()).toBe(20);
    await user.keyboard('{ArrowLeft}');
    expect(valueNow()).toBe(20);
    await user.keyboard('{Enter}');
    expect(valueNow()).toBe(50);
    expect(onCommit).toHaveBeenLastCalledWith(50);
    expect(separator()).toHaveAttribute('aria-valuetext', '원본 50%, 변환본 50%');
  });

  it('vertical: ↑/↓ ±5 and ←/→ are ignored (not prevented)', () => {
    render(<Controlled orientation="vertical" />);
    const sep = separator();
    fireEvent.keyDown(sep, { key: 'ArrowDown' });
    expect(valueNow()).toBe(55);
    fireEvent.keyDown(sep, { key: 'ArrowUp' });
    fireEvent.keyDown(sep, { key: 'ArrowUp' });
    expect(valueNow()).toBe(45);
    const ignored = fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(ignored).toBe(true);
    expect(valueNow()).toBe(45);
  });

  it('works uncontrolled from defaultRatio', () => {
    render(
      <SplitView separatorLabel={LABEL} defaultRatio={40}>
        <p>가</p>
        <p>나</p>
      </SplitView>,
    );
    expect(valueNow()).toBe(40);
    fireEvent.keyDown(separator(), { key: 'ArrowRight' });
    expect(valueNow()).toBe(45);
    fireEvent.keyDown(separator(), { key: 'Enter' });
    expect(valueNow()).toBe(40);
  });
});

describe('SplitView minimum sizes', () => {
  it('splitRange combines the % and px minimums and locks 50:50 when both do not fit', () => {
    expect(splitRange(null, 20, 320)).toEqual({ min: 20, max: 80 });
    expect(splitRange(2000, 20, 320)).toEqual({ min: 20, max: 80 });
    expect(splitRange(1000, 20, 320)).toEqual({ min: 32, max: 68 });
    expect(splitRange(900, 20, 320)).toEqual({ min: 36, max: 64 });
    expect(splitRange(640, 20, 320)).toEqual({ min: 50, max: 50 });
    expect(splitRange(500, 20, 320)).toEqual({ min: 50, max: 50 });
  });

  it('applies the px minimum of the current axis to the measured pane space', () => {
    mockPaneSpace(1000);
    const { rerender } = render(
      <Controlled initial={80} minSize={{ horizontal: 320, vertical: 200 }} />,
    );
    expect(separator()).toHaveAttribute('aria-valuemin', '32');
    expect(separator()).toHaveAttribute('aria-valuemax', '68');
    expect(valueNow()).toBe(68);
    rerender(
      <Controlled
        initial={80}
        orientation="vertical"
        minSize={{ horizontal: 320, vertical: 200 }}
      />,
    );
    expect(separator()).toHaveAttribute('aria-valuemin', '20');
    expect(separator()).toHaveAttribute('aria-valuemax', '80');
  });

  it('a container smaller than both minimums pins the separator at 50', () => {
    mockPaneSpace(500);
    render(<Controlled initial={70} minSize={320} />);
    const sep = separator();
    expect(sep).toHaveAttribute('aria-valuemin', '50');
    expect(sep).toHaveAttribute('aria-valuemax', '50');
    expect(sep).not.toHaveAttribute('aria-disabled');
    expect(valueNow()).toBe(50);
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(valueNow()).toBe(50);
  });
});

describe('SplitView pointer drag', () => {
  beforeEach(() => {
    mockPaneSpace(1000);
  });

  it.each(['mouse', 'touch', 'pen'])(
    '%s drag moves by the pointer delta, clamps at the minimum and commits once on release',
    (pointerType) => {
      const onCommit = vi.fn();
      render(<Controlled onCommit={onCommit} minSize={320} />);
      const sep = separator();
      const capture = vi.fn();
      sep.setPointerCapture = capture;
      const base = { pointerId: 7, pointerType, isPrimary: true, button: 0 };
      fireEvent.pointerDown(sep, { ...base, buttons: 1, clientX: 500, clientY: 300 });
      expect(capture).toHaveBeenCalledWith(7);
      expect(sep.closest('.qz-split')).toHaveAttribute('data-dragging');
      fireEvent.pointerMove(sep, { ...base, buttons: 1, clientX: 600, clientY: 300 });
      expect(valueNow()).toBe(60);
      expect(onCommit).not.toHaveBeenCalled();
      // Far past the end: the second pane keeps 320px of 1000px.
      fireEvent.pointerMove(sep, { ...base, buttons: 1, clientX: 1400, clientY: 300 });
      expect(valueNow()).toBe(68);
      fireEvent.pointerUp(sep, { ...base, buttons: 0, clientX: 1400, clientY: 300 });
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith(68);
      expect(sep.closest('.qz-split')).not.toHaveAttribute('data-dragging');
    },
  );

  it('a vertical drag follows clientY', () => {
    render(<Controlled orientation="vertical" />);
    const sep = separator();
    const base = { pointerId: 1, pointerType: 'mouse', button: 0 };
    fireEvent.pointerDown(sep, { ...base, buttons: 1, clientX: 10, clientY: 400 });
    fireEvent.pointerMove(sep, { ...base, buttons: 1, clientX: 400, clientY: 350 });
    expect(valueNow()).toBe(45);
    fireEvent.pointerUp(sep, { ...base, clientX: 400, clientY: 350 });
  });

  it('pointerdown prevents the default so no text selection starts; other pointers are ignored', () => {
    render(<Controlled />);
    const sep = separator();
    const notPrevented = fireEvent.pointerDown(sep, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 500,
    });
    expect(notPrevented).toBe(false);
    fireEvent.pointerMove(sep, { pointerId: 2, pointerType: 'touch', clientX: 900 });
    expect(valueNow()).toBe(50);
    fireEvent.pointerUp(sep, { pointerId: 1, pointerType: 'mouse', clientX: 500 });
  });

  it('ignores secondary mouse buttons', () => {
    render(<Controlled />);
    const sep = separator();
    fireEvent.pointerDown(sep, { pointerId: 1, pointerType: 'mouse', button: 2, clientX: 500 });
    fireEvent.pointerMove(sep, { pointerId: 1, pointerType: 'mouse', clientX: 700 });
    expect(valueNow()).toBe(50);
  });
});

describe('SplitView reset', () => {
  it('double click resets to defaultRatio and commits', () => {
    const onCommit = vi.fn();
    render(<Controlled initial={70} defaultRatio={50} onCommit={onCommit} />);
    fireEvent.doubleClick(separator());
    expect(valueNow()).toBe(50);
    expect(onCommit).toHaveBeenCalledWith(50);
  });

  it('a touch double tap resets; a single tap or two slow taps do not', () => {
    const onCommit = vi.fn();
    render(<Controlled initial={70} onCommit={onCommit} />);
    const sep = separator();
    const now = vi.spyOn(Date, 'now');
    const tap = (time: number) => {
      const init = { pointerId: 3, pointerType: 'touch', button: 0, clientX: 100, clientY: 100 };
      now.mockReturnValue(time);
      fireEvent.pointerDown(sep, { ...init, buttons: 1 });
      fireEvent.pointerUp(sep, init);
    };
    tap(1000);
    expect(valueNow()).toBe(70);
    tap(2000);
    expect(valueNow()).toBe(70);
    tap(2200);
    expect(valueNow()).toBe(50);
    expect(onCommit).toHaveBeenCalledWith(50);
  });
});

describe('SplitView swap', () => {
  it('swapping keyed children keeps each pane mounted and aria-controls on the first visual pane', async () => {
    const user = userEvent.setup();
    const mounts = { pdf: 0, text: 0 };
    function Pane({ id, label }: { id: 'pdf' | 'text'; label: string }) {
      useEffect(() => {
        mounts[id] += 1;
      }, [id]);
      return (
        <section aria-label={label}>
          <input aria-label={`${label} 입력`} />
        </section>
      );
    }
    function Swappable({ swapped }: { swapped: boolean }) {
      const a = <Pane key="pdf" id="pdf" label="PDF 원본" />;
      const b = <Pane key="text" id="text" label="변환본 텍스트" />;
      return (
        <SplitView separatorLabel={LABEL} defaultRatio={60} ratio={swapped ? 40 : 60}>
          {swapped ? [b, a] : [a, b]}
        </SplitView>
      );
    }
    const { rerender } = render(<Swappable swapped={false} />);
    const input = screen.getByRole('textbox', { name: '변환본 텍스트 입력' });
    await user.type(input, '교정 중');
    const pdfRegion = screen.getByRole('region', { name: 'PDF 원본' });

    rerender(<Swappable swapped />);
    expect(mounts).toEqual({ pdf: 1, text: 1 });
    expect(screen.getByRole('textbox', { name: '변환본 텍스트 입력' })).toBe(input);
    expect(input).toHaveValue('교정 중');
    expect(screen.getByRole('region', { name: 'PDF 원본' })).toBe(pdfRegion);

    // DOM order follows the visual order, and the separator controls the new first pane.
    const panes = document.querySelectorAll('.qz-split > .pane');
    expect(panes[0]).toContainElement(screen.getByRole('region', { name: '변환본 텍스트' }));
    expect(panes[1]).toContainElement(pdfRegion);
    const controlled = document.getElementById(separator().getAttribute('aria-controls') ?? '');
    expect(controlled).toBe(panes[0]);
    expect(valueNow()).toBe(40);

    rerender(<Swappable swapped={false} />);
    expect(mounts).toEqual({ pdf: 1, text: 1 });
    expect(
      document.getElementById(separator().getAttribute('aria-controls') ?? ''),
    ).toContainElement(pdfRegion);
  });
});
