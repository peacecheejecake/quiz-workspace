import type { Meta, StoryObj } from '@storybook/react-vite';
import { EmptyState } from '../feedback/EmptyState';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { Skeleton } from '../primitives/Skeleton';
import { Surface } from '../primitives/Surface';
import { AppShell } from './AppShell';
import { PageHeader } from './PageHeader';

const navLinks = ['문서', '검색', '문제', '설정'];

const sidebar = (
  <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-1)' }}>
    {navLinks.map((label, i) => (
      <li key={label}>
        <a
          href={`#${label}`}
          className="qz-button qz-focus-ring"
          data-variant="ghost"
          aria-current={i === 0 ? 'page' : undefined}
          style={{ width: '100%', justifyContent: 'flex-start' }}
        >
          {label}
        </a>
      </li>
    ))}
  </ul>
);

const header = (
  <>
    <strong style={{ fontSize: 16 }}>Quiz Workspace</strong>
    <span style={{ marginLeft: 'auto' }}>
      <Badge tone="accent">운영체제 스터디</Badge>
    </span>
  </>
);

const meta = {
  title: 'Layout/AppShell',
  component: AppShell,
  args: { header, sidebar },
  parameters: {
    layout: 'fullscreen',
    docs: {
      story: { inline: false, height: '560px' },
      description: {
        component:
          'App frame (§4): 64px header (glass top bar), 232px sidebar from 1024px, modal ' +
          'drawer navigation below that, content max-width 1440px with 24px (≥ 768px) / 16px ' +
          'padding, skip link to <main>. Use with PageHeader + content.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div style={{ margin: 'calc(-1 * var(--space-6))' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AppShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  args: {
    children: (
      <>
        <PageHeader
          title="문서"
          description="업로드한 책과 강의 자료"
          actions={<Button variant="primary">PDF 업로드</Button>}
        />
        <div
          style={{
            display: 'grid',
            gap: 'var(--space-4)',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          }}
        >
          {['운영체제', '데이터베이스', '네트워크'].map((title) => (
            <Surface key={title}>
              <strong>{title}</strong>
              <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--color-text-secondary)' }}>
                320쪽 · 문제 48개
              </p>
            </Surface>
          ))}
        </div>
      </>
    ),
  },
};

export const Empty: Story = {
  args: {
    children: (
      <>
        <PageHeader title="문서" />
        <Surface>
          <EmptyState
            title="아직 문서가 없습니다"
            description="PDF를 업로드하면 목차와 검색, 문제 생성이 준비됩니다."
            action={<Button variant="primary">PDF 업로드</Button>}
          />
        </Surface>
      </>
    ),
  },
};

export const Loading: Story = {
  args: {
    children: (
      <div aria-busy="true">
        <span className="qz-visually-hidden">불러오는 중</span>
        <Skeleton width={160} height={28} />
        <Skeleton shape="rect" height={160} style={{ marginTop: 'var(--space-6)' }} />
      </div>
    ),
  },
};

export const Mobile: Story = {
  ...Desktop,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const Tablet: Story = {
  ...Desktop,
  globals: { viewport: { value: 'tablet', isRotated: false } },
};

export const Dark: Story = { ...Desktop, globals: { theme: 'dark' } };
