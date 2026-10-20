import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Dropzone, type DropzoneProps } from './Dropzone';

const meta = {
  title: 'Foundation/Dropzone',
  component: Dropzone,
  args: {
    title: 'PDF 파일을 여기에 끌어다 놓으세요',
    description: 'PDF만 올릴 수 있습니다 · 최대 50MB',
    accept: '.pdf,application/pdf',
    onFiles: () => undefined,
  },
  parameters: {
    docs: {
      description: {
        component:
          'Dashed file drop region with a real "파일 선택" button (keyboard, touch and screen ' +
          'reader path; the hidden input is not a tab stop). Dragging files over it sets ' +
          '`data-dragging` (solid accent border + selected tint + accent icon, never color ' +
          'alone: the border style changes too). Dropped files are filtered by `accept` like ' +
          'the picker; others go to `onReject`. Without `multiple` only the first file is ' +
          'delivered. Transitions use --qz-transition-fast and collapse for reduced motion.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Dropzone>;

export default meta;
type Story = StoryObj<typeof meta>;

function WithResult(args: DropzoneProps) {
  const [names, setNames] = useState<string[]>([]);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <Dropzone {...args} onFiles={(files) => setNames(files.map((f) => f.name))} />
      <p role="status" style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
        {names.length ? `선택한 파일: ${names.join(', ')}` : '선택한 파일 없음'}
      </p>
    </div>
  );
}

export const Default: Story = { render: (args) => <WithResult {...args} /> };
export const Multiple: Story = {
  args: { multiple: true, title: '파일을 여러 개 끌어다 놓을 수 있습니다' },
  render: (args) => <WithResult {...args} />,
};
export const Dragging: Story = {
  name: 'Dragging (drag-over state)',
  // The drag-over look, pinned for review (a real drag sets the attribute itself).
  play: ({ canvasElement }) => {
    canvasElement.querySelector('.qz-dropzone')?.setAttribute('data-dragging', '');
  },
};
export const Disabled: Story = { args: { disabled: true } };
export const Dark: Story = { ...Default, globals: { theme: 'dark' } };
