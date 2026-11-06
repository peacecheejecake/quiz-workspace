import type { Meta, StoryObj } from '@storybook/react-vite';
import { StepList } from './StepList';

const steps = [
  { id: 'options', label: '옵션' },
  { id: 'range', label: '범위' },
];

const meta = {
  title: 'Feedback/StepList',
  component: StepList,
  args: { label: '모의고사 단계', steps, current: 0 },
} satisfies Meta<typeof StepList>;
export default meta;

type Story = StoryObj<typeof meta>;

export const First: Story = {};

export const SecondGoesBack: Story = {
  args: {
    current: 1,
    onStepSelect: () => undefined,
    stepActionLabel: (step) => `${step.label} 단계로 돌아가기`,
  },
};
