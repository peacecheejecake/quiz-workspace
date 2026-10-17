import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageHeader } from '../layout/PageHeader';
import { Button } from '../primitives/Button';
import { AlertIcon } from '../primitives/icons';
import { Surface } from '../primitives/Surface';
import { EmptyState } from './EmptyState';

const meta = {
  title: 'Layout/EmptyState',
  component: EmptyState,
  args: {
    title: '아직 문제가 없습니다',
    description: '문서를 선택하고 문제 생성을 시작하세요. 생성된 문제는 검토 후 확정됩니다.',
    action: <Button variant="primary">문제 생성</Button>,
  },
  parameters: {
    docs: {
      description: {
        component:
          'Explains an empty list/view and offers the next step. Choose `headingLevel` to fit ' +
          'the page outline. Tokens: --color-text-primary/secondary, --space-*.',
      },
    },
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Surface>
      <EmptyState {...args} />
    </Surface>
  ),
};

export const WithIcon: Story = {
  ...Default,
  args: { icon: <AlertIcon width={32} height={32} />, title: '검색 결과가 없습니다' },
};

export const Dark: Story = { ...Default, globals: { theme: 'dark' } };

export const PageHeaderExample: Story = {
  name: 'PageHeader',
  render: () => (
    <PageHeader
      breadcrumb={
        <nav aria-label="이동 경로">
          <a href="#workspaces">Workspaces</a> / 운영체제
        </nav>
      }
      title="문제"
      description="확정된 문제 128개 · 검토 대기 6개"
      actions={
        <>
          <Button>가져오기</Button>
          <Button variant="primary">문제 생성</Button>
        </>
      }
    />
  ),
};
