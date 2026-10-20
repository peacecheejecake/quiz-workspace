import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../primitives/Button';
import { BackLink, Breadcrumb } from './Breadcrumb';
import { PageHeader } from './PageHeader';

const ITEMS = [
  { label: '운영체제', href: '#workspace' },
  { label: '문서', href: '#documents' },
  { label: '3장 프로세스와 스레드' },
];

const meta = {
  title: 'Layout/Breadcrumb',
  component: Breadcrumb,
  args: { items: ITEMS },
  parameters: {
    docs: {
      description: {
        component:
          'Location trail: `<nav aria-label="위치">` + ordered list, decorative chevrons, the ' +
          'last item is the current page (`aria-current="page"`, semibold, not a link). Pass ' +
          '`linkComponent={Link}` for next/link. `BackLink` is the back control for pages ' +
          'reached by a button: a link with `href` (also `linkComponent`), otherwise a button ' +
          'whose onClick goes back; `hideLabel` keeps the label as the accessible name only. ' +
          "Both go into PageHeader's `back` / `breadcrumb` slots.",
      },
    },
  },
} satisfies Meta<typeof Breadcrumb>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Back: Story = {
  name: 'BackLink',
  render: () => (
    <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}>
      <BackLink href="#documents" label="문서 목록" />
      <BackLink label="뒤로" onClick={() => window.history.back()} />
      <BackLink label="뒤로" hideLabel onClick={() => window.history.back()} />
    </div>
  ),
};

export const InPageHeader: Story = {
  name: 'In PageHeader',
  render: () => (
    <PageHeader
      title="3장 프로세스와 스레드"
      description="process-thread.pdf"
      back={<BackLink href="#documents" label="문서 목록" />}
      breadcrumb={<Breadcrumb items={ITEMS} />}
      actions={<Button variant="primary">게시</Button>}
    />
  ),
};

export const Dark: Story = { ...InPageHeader, globals: { theme: 'dark' } };
