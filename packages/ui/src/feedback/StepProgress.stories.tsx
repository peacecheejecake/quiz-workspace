import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Button } from '../primitives/Button';
import { StepProgress } from './StepProgress';

const STEPS = [
  { id: 'upload', label: '업로드' },
  { id: 'parse', label: 'PDF 분석' },
  { id: 'extract', label: '문제 추출' },
];

const meta = {
  title: 'Feedback/StepProgress',
  component: StepProgress,
  args: { label: '가져오기 진행률', steps: STEPS, current: 1, value: 45 },
  parameters: {
    docs: {
      description: {
        component:
          'Multi-step job progress (UX6-PROGRESS): an ordered step list (done = check icon, ' +
          'current = bold number with aria-current="step", pending = number; each also says its ' +
          'state in visually hidden text) above one bar split into a segment per step. Done ' +
          'segments are full and the current one fills with its own progress, so the bar never ' +
          'drops back between steps. `value` undefined = indeterminate current step.',
      },
    },
  },
} satisfies Meta<typeof StepProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <div style={{ maxWidth: '24rem' }}>
      <StepProgress {...args} />
    </div>
  ),
};

export const Indeterminate: Story = {
  ...Default,
  args: { value: undefined, currentText: 'PDF 분석 대기 중' },
};

export const Done: Story = { ...Default, args: { current: 3 } };

/** A job's reports (step, %): each step's segment fills in turn; nothing goes backwards. */
export const Walkthrough: Story = {
  render: function Render(args) {
    const reports: [number, number | undefined][] = [
      [0, 20],
      [0, 100],
      [1, undefined],
      [1, 30],
      [1, 90],
      [2, 10],
      [2, 80],
      [3, undefined],
    ];
    const [index, setIndex] = useState(0);
    const [current, value] = reports[index] ?? [0, 0];
    return (
      <div style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: '24rem' }}>
        <StepProgress {...args} current={current} value={value} />
        <Button onClick={() => setIndex((i) => (i + 1) % reports.length)}>다음 보고</Button>
      </div>
    );
  },
};
