import type { Meta, StoryObj } from '@storybook/react-vite';
import { ThemeProvider } from '../theme/ThemeProvider';
import { Badge } from './Badge';
import { Button } from './Button';
import { FocusRing } from './FocusRing';
import { Skeleton } from './Skeleton';
import { GlassSurface, Surface } from './Surface';

const row = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-3)',
  alignItems: 'center',
} as const;

const meta = {
  title: 'Foundation/Surface',
  component: Surface,
  args: { children: '카드 내용', padding: 'md', tone: 'default' },
  parameters: {
    docs: {
      description: {
        component:
          'Surface is the opaque default for cards and reading areas. GlassSurface is only for ' +
          'floating interaction layers; it falls back to the opaque surface when backdrop-filter ' +
          'is unsupported or prefers-reduced-transparency is set. Wrong usage: blurring every ' +
          'surface, placing glass over PDF/reading content, hard-coding status hex values.',
      },
    },
  },
} satisfies Meta<typeof Surface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Muted: Story = { args: { tone: 'muted' } };

export const Glass: Story = {
  render: () => (
    <div style={{ position: 'relative', maxWidth: 480 }}>
      <Surface padding="lg">
        <p style={{ margin: 0 }}>
          배경 콘텐츠입니다. Glass 표면은 이 위에 떠 있는 계층에만 사용합니다.
        </p>
        <Skeleton width="80%" />
        <Skeleton width="60%" style={{ marginTop: 'var(--space-2)' }} />
      </Surface>
      <GlassSurface
        style={{
          position: 'absolute',
          right: 'var(--space-4)',
          bottom: 'calc(-1 * var(--space-6))',
        }}
      >
        떠 있는 glass 표면
      </GlassSurface>
    </div>
  ),
};

export const Badges: Story = {
  render: () => (
    <div style={row}>
      <Badge>기본</Badge>
      <Badge tone="accent">공유됨</Badge>
      <Badge tone="success">정답</Badge>
      <Badge tone="warning">다시 풀기</Badge>
      <Badge tone="danger">오답</Badge>
    </div>
  ),
};

export const SkeletonLoading: Story = {
  render: () => (
    <Surface aria-busy="true" style={{ maxWidth: 360 }}>
      <span className="qz-visually-hidden">불러오는 중</span>
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
        <Skeleton shape="circle" width={40} height={40} />
        <div style={{ flex: 1, display: 'grid', gap: 'var(--space-2)' }}>
          <Skeleton width="70%" />
          <Skeleton width="40%" />
        </div>
      </div>
      <Skeleton shape="rect" height={96} style={{ marginTop: 'var(--space-4)' }} />
    </Surface>
  ),
};

export const FocusRingExample: Story = {
  name: 'FocusRing',
  render: () => (
    <div style={row}>
      <FocusRing>
        <a href="#focus">FocusRing을 적용한 링크</a>
      </FocusRing>
      <Button>Button (내장)</Button>
    </div>
  ),
  parameters: { pseudo: { focusVisible: true } },
};

export const LightAndDark: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
      {(['light', 'dark'] as const).map((theme) => (
        <ThemeProvider key={theme} theme={theme} scope="element">
          <div style={{ padding: 'var(--space-4)', display: 'grid', gap: 'var(--space-3)' }}>
            <Surface>{theme} surface</Surface>
            <div style={row}>
              <Button variant="primary">Primary</Button>
              <Badge tone="danger">오답</Badge>
            </div>
          </div>
        </ThemeProvider>
      ))}
    </div>
  ),
};
