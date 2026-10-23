import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Button } from '../primitives/Button';
import { ProgressBar } from './ProgressBar';

const meta = {
  title: 'Feedback/ProgressBar',
  component: ProgressBar,
  args: { label: '업로드 진행률', value: 40 },
  parameters: {
    docs: {
      description: {
        component:
          'Accessible progress bar (`role="progressbar"`, `value` undefined = indeterminate). The ' +
          'fill glides between reported values over --duration-progress / --easing-standard and ' +
          'switches instantly under prefers-reduced-motion. Size it with `className` (max-width).',
      },
    },
  },
} satisfies Meta<typeof ProgressBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <div style={{ maxWidth: '20rem' }}>
      <ProgressBar {...args} />
    </div>
  ),
};

export const Indeterminate: Story = { ...Default, args: { value: undefined } };

/** Coarse server steps (2 → 40 → 60 → 90 → 100 %): the fill glides between them. */
export const Steps: Story = {
  render: function Render(args) {
    const steps = [2, 40, 60, 90, 100];
    const [index, setIndex] = useState(0);
    return (
      <div style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: '20rem' }}>
        <ProgressBar {...args} value={steps[index]} />
        <Button onClick={() => setIndex((i) => (i + 1) % steps.length)}>다음 단계</Button>
      </div>
    );
  },
};
