import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { Checkbox } from '../primitives/Checkbox';
import { IconButton } from '../primitives/IconButton';
import { AlertIcon, CheckIcon } from '../primitives/icons';
import { Input } from '../primitives/Input';
import { Skeleton } from '../primitives/Skeleton';
import { Surface } from '../primitives/Surface';
import { Tooltip } from '../primitives/Tooltip';
import { FloatingSidePanel, type FloatingSidePanelProps } from './FloatingSidePanel';

const meta = {
  title: 'Layout/FloatingSidePanel',
  component: FloatingSidePanel,
  args: {
    title: '1장 · 문제 3',
    description: '객관식 · 다시 풀기',
    modal: true,
    defaultOpen: true,
    closeLabel: '닫기',
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      story: { inline: false, height: '640px' },
      description: {
        component:
          'Shared side panel (design-system §5.1). Desktop: min(500px, 100vw - 32px) wide, 16px ' +
          'viewport margins, radius 20px, glass surface, independent body scroll. Mobile ' +
          '(< 768px): bottom sheet up to 90dvh or full height. ' +
          '**Modal** (QuestionPracticePanel): backdrop, focus trap, background inert, Escape ' +
          'and backdrop click close, focus returns to the opener. ' +
          '**Non-modal** (DocumentExcerptPanel): no backdrop or trap; the background stays ' +
          'clickable and focusable and does not dismiss the panel; Escape closes only while ' +
          'focus is inside; focus returns to the opener. Layer: --z-side-panel; motion: ' +
          '--duration-panel-enter/exit (transform + opacity), disabled for reduced motion.',
      },
    },
  },
} satisfies Meta<typeof FloatingSidePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

function Background() {
  return (
    <main style={{ display: 'grid', gap: 'var(--space-4)', maxWidth: 640 }}>
      <h1 style={{ margin: 0, fontSize: 26 }}>문서 뷰어</h1>
      <Input label="검색어" placeholder="배경 입력 (non-modal에서는 패널을 연 채 입력 가능)" />
      {Array.from({ length: 6 }, (_, i) => (
        <Surface key={i}>
          <strong>{i + 1}쪽</strong>
          <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--color-text-secondary)' }}>
            본문 텍스트 블록입니다. 패널이 떠 있어도 읽기 영역은 불투명 표면을 유지합니다.
          </p>
        </Surface>
      ))}
    </main>
  );
}

const practiceBody = (
  <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
    <p style={{ margin: 0 }}>다음 중 정규화의 목적으로 가장 옳은 것은?</p>
    {['데이터 중복 최소화', '조회 속도 향상만을 위해', '저장 공간 확대', '보안 강화'].map((o) => (
      <Checkbox key={o} label={o} />
    ))}
  </div>
);

function Demo(args: FloatingSidePanelProps) {
  const [open, setOpen] = useState(args.defaultOpen ?? false);
  return (
    <div style={{ padding: 'var(--space-6)' }}>
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <Button variant="primary" onClick={() => setOpen(true)}>
          패널 열기
        </Button>
      </div>
      <Background />
      <FloatingSidePanel {...args} defaultOpen={undefined} open={open} onOpenChange={setOpen} />
    </div>
  );
}

const headerActions = (
  <>
    <Tooltip content="즐겨찾기">
      <IconButton label="즐겨찾기" icon={<CheckIcon />} />
    </Tooltip>
    <Badge tone="warning">다시 풀기</Badge>
  </>
);

const footer = (
  <>
    <Button>이전</Button>
    <Button variant="primary">제출</Button>
  </>
);

export const Modal: Story = {
  args: { headerActions, footer, children: practiceBody },
  render: (args) => <Demo {...args} />,
};

export const NonModal: Story = {
  args: {
    modal: false,
    title: '검색 발췌',
    description: '3장 · 42쪽',
    children: (
      <p style={{ margin: 0 }}>
        정규화는 관계형 데이터베이스에서 중복을 줄이고 무결성을 높이기 위해 테이블을 분해하는
        과정이다.
      </p>
    ),
    footer: <Button>원문으로 이동</Button>,
  },
  render: (args) => <Demo {...args} />,
};

export const NoBackdropClose: Story = {
  ...Modal,
  args: { ...Modal.args, closeOnBackdropClick: false },
};

export const ViewportOverflow: Story = {
  args: {
    footer,
    children: (
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        {Array.from({ length: 30 }, (_, i) => (
          <p key={i} style={{ margin: 0 }}>
            긴 해설 문단 {i + 1}. 패널 본문만 독립적으로 스크롤되고 header/footer는 고정됩니다.
          </p>
        ))}
      </div>
    ),
  },
  render: (args) => <Demo {...args} />,
};

export const Loading: Story = {
  args: {
    children: (
      <div aria-busy="true" style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <span className="qz-visually-hidden">불러오는 중</span>
        <Skeleton width="90%" />
        <Skeleton width="70%" />
        <Skeleton shape="rect" height={120} />
      </div>
    ),
    footer: (
      <Button variant="primary" loading>
        제출 중
      </Button>
    ),
  },
  render: (args) => <Demo {...args} />,
};

export const ErrorState: Story = {
  name: 'Error',
  args: {
    children: practiceBody,
    footer: (
      <>
        <p
          role="alert"
          style={{ margin: 0, marginRight: 'auto', display: 'flex', gap: 'var(--space-1)' }}
        >
          <AlertIcon width={16} height={16} />
          제출에 실패했습니다. 다시 시도하세요.
        </p>
        <Button variant="primary">다시 시도</Button>
      </>
    ),
  },
  render: (args) => <Demo {...args} />,
};

export const Empty: Story = {
  args: {
    title: '검색 발췌',
    modal: false,
    children: (
      <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
        선택한 결과에 표시할 발췌가 없습니다.
      </p>
    ),
  },
  render: (args) => <Demo {...args} />,
};

export const Wide: Story = {
  args: { size: 'wide', title: '생성 문제 검토', children: practiceBody, footer },
  render: (args) => <Demo {...args} />,
};

export const Dark: Story = { ...Modal, globals: { theme: 'dark' } };
export const DarkNonModal: Story = { ...NonModal, globals: { theme: 'dark' } };

export const MobileBottomSheet: Story = {
  ...Modal,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const MobileFullHeight: Story = {
  ...Modal,
  args: { ...Modal.args, mobileLayout: 'full' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const Tablet: Story = {
  ...NonModal,
  globals: { viewport: { value: 'tablet', isRotated: false } },
};
