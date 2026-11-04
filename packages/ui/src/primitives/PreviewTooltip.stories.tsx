import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Button } from './Button';
import { PreviewTooltip } from './PreviewTooltip';
import { Spinner } from './Spinner';

const meta = {
  title: 'Foundation/PreviewTooltip',
  component: PreviewTooltip,
  parameters: {
    docs: {
      description: {
        component:
          'Rich preview that hangs from a trigger (design-system §5.6, QSRC-01). Opens on hover, ' +
          'keyboard `:focus-visible` and a 500 ms touch long-press; the trigger points at it with ' +
          '`aria-describedby`. A long-press swallows the release click (the trigger’s click, e.g. ' +
          'a dialog, does not fire); a short tap clicks. Escape or a touch outside closes only the ' +
          'tooltip, and the dismissing tap reaches nothing underneath. Loading (`role="status"`) ' +
          'and failure texts come from the caller.',
      },
    },
  },
} satisfies Meta<typeof PreviewTooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

function Demo({ state }: { state: 'ready' | 'loading' | 'failed' }) {
  const [clicks, setClicks] = useState(0);
  const content =
    state === 'loading' ? (
      <span role="status" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
        <Spinner /> 원문을 불러오는 중입니다
      </span>
    ) : state === 'failed' ? (
      <span>원문을 불러오지 못했습니다</span>
    ) : (
      <div
        role="img"
        aria-label="문제 원문 p.1"
        style={{
          width: 280,
          height: 120,
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-surface-muted)',
        }}
      />
    );
  return (
    <div style={{ padding: 'var(--space-8)' }}>
      <PreviewTooltip content={content}>
        <Button onClick={() => setClicks((n) => n + 1)}>문제 원문 보기</Button>
      </PreviewTooltip>
      <p style={{ color: 'var(--color-text-secondary)' }}>클릭 {clicks}회</p>
    </div>
  );
}

export const Ready: Story = {
  args: { content: null, children: <span /> },
  render: () => <Demo state="ready" />,
};
export const Loading: Story = {
  args: { content: null, children: <span /> },
  render: () => <Demo state="loading" />,
};
export const Failed: Story = {
  args: { content: null, children: <span /> },
  render: () => <Demo state="failed" />,
};
