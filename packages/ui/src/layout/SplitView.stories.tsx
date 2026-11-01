import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '../primitives/Button';
import { SplitView, type SplitViewProps } from './SplitView';

const valueText = (r: number) => `원본 ${r}%, 변환본 ${100 - r}%`;

const meta = {
  title: 'Layout/SplitView',
  component: SplitView,
  args: {
    orientation: 'horizontal',
    separatorLabel: '원본과 변환본 크기 조절',
    valueText,
    minRatio: 20,
    minSize: { horizontal: 320, vertical: 200 },
    defaultRatio: 50,
    visible: 'both',
    children: [null, null],
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Two panes and a resize separator (design-system §7, first use DOCVIEW-01). The bar is ' +
          'a focusable `role="separator"`: `aria-valuenow` = first pane %, `aria-orientation` ' +
          'is the opposite of the split axis, `aria-valuetext` comes from `valueText`. ' +
          'Keyboard: split-axis arrows ±5, Home/End = min/max, Enter = reset; the other axis is ' +
          'ignored. Pointer Events drag (mouse, touch, pen; pointer capture, `touch-action: ' +
          'none`, no text selection), double click / double tap = reset. Each pane keeps ' +
          '`minRatio`% and `minSize`px; when both do not fit the split is pinned at 50:50. ' +
          'Line 1px `--color-border`, hit area 24px (coarse pointer 44px); hover, focus-visible ' +
          'and drag thicken the line and show a grip. Reduced motion: no transitions. ' +
          'Swapping panes = swapping `children` (with keys) in the caller.',
      },
    },
  },
} satisfies Meta<typeof SplitView>;

export default meta;
type Story = StoryObj<typeof meta>;

const paneStyle: CSSProperties = {
  boxSizing: 'border-box',
  height: '100%',
  padding: 'var(--space-4)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
  fontFamily: 'var(--font-sans)',
};

function Pane({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <section aria-label={label} style={paneStyle}>
      <h2 style={{ margin: 0, fontSize: 'var(--font-size-section-title)' }}>{label}</h2>
      <p style={{ color: 'var(--color-text-secondary)' }}>
        끌거나 막대에 focus를 두고 화살표 키로 크기를 바꿉니다. 끄는 동안 이 문장이 선택되지
        않습니다.
      </p>
      {children}
    </section>
  );
}

function Demo({
  height = 480,
  width,
  ...args
}: SplitViewProps & { height?: number; width?: number }) {
  const [ratio, setRatio] = useState(args.ratio ?? args.defaultRatio ?? 50);
  const [committed, setCommitted] = useState(ratio);
  const [swapped, setSwapped] = useState(false);
  const panes = [
    <Pane key="pdf" label="PDF 원본" />,
    <Pane key="text" label="변환본 텍스트" />,
  ] as const;
  // aria-valuenow is the first pane's share; the stored value is the PDF pane's.
  const first = swapped ? 100 - ratio : ratio;
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
        <Button onClick={() => setSwapped((v) => !v)}>위치 바꾸기</Button>
        <span style={{ color: 'var(--color-text-secondary)' }}>
          원본 {ratio}% (저장값 {committed}%)
        </span>
      </div>
      <div style={{ height, width, maxWidth: '100%' }}>
        <SplitView
          {...args}
          style={{ height: '100%' }}
          ratio={first}
          onRatioChange={(r) => setRatio(swapped ? 100 - r : r)}
          onRatioCommit={(r) => setCommitted(swapped ? 100 - r : r)}
          valueText={(r) => valueText(swapped ? 100 - r : r)}
        >
          {swapped ? [panes[1], panes[0]] : [panes[0], panes[1]]}
        </SplitView>
      </div>
    </div>
  );
}

/** 좌우: ←/→ ±5, Home/End, Enter / double click = 50:50. */
export const Horizontal: Story = { render: (args) => <Demo {...args} /> };

/** 상하: ↑/↓ ±5; ←/→ are ignored. Each pane keeps 200px. */
export const Vertical: Story = {
  args: { orientation: 'vertical' },
  render: (args) => <Demo {...args} height={640} />,
};

/** 원본 60%: the first pane starts wider. */
export const Ratio60: Story = {
  args: { ratio: 60 },
  render: (args) => <Demo {...args} />,
};

/** Narrower than both minimums (2 × 320px): pinned at 50:50, valuemin = valuemax = 50. */
export const NarrowContainer: Story = {
  render: (args) => <Demo {...args} width={600} />,
};

/** 원본만: the other pane stays mounted with `hidden`; no separator. */
export const FirstPaneOnly: Story = {
  args: { visible: 'first' },
  render: (args) => <Demo {...args} />,
};
