import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToastProvider, useToast } from '../feedback/Toast';
import { DialogClose, ModalDialog } from '../layout/ModalDialog';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { MenuIcon } from './icons';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';
import { Tooltip } from './Tooltip';

const meta = {
  title: 'Foundation/Tooltip',
  component: Tooltip,
  args: { content: '메뉴 열기', children: <IconButton label="메뉴" icon={<MenuIcon />} /> },
  parameters: {
    docs: {
      description: {
        component:
          'Hover/focus hint (Radix Tooltip). Opens on keyboard focus too and closes on Escape; ' +
          'only supplementary text. Layer: --z-popover, lifted above an enclosing panel.',
      },
    },
  },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Open: Story = { args: { open: true } };
export const OpenDark: Story = { args: { open: true }, globals: { theme: 'dark' } };

export const PopoverDefault: Story = {
  name: 'Popover',
  render: () => (
    <Popover defaultOpen>
      <PopoverTrigger asChild>
        <Button>문제 미리보기</Button>
      </PopoverTrigger>
      <PopoverContent aria-label="문제 미리보기" closeLabel="닫기" side="bottom" align="start">
        <strong>1장 · 문제 3 · 객관식</strong>
        <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--color-text-secondary)' }}>
          다음 중 정규화의 목적으로 옳은 것은?
        </p>
      </PopoverContent>
    </Popover>
  ),
};

function ToastDemo() {
  const { toast } = useToast();
  return (
    <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
      <Button onClick={() => toast({ title: '저장했습니다' })}>Neutral</Button>
      <Button onClick={() => toast({ title: '링크를 복사했습니다', tone: 'success' })}>
        Success
      </Button>
      <Button
        onClick={() =>
          toast({
            title: '업로드에 실패했습니다',
            description: '네트워크 연결을 확인하세요.',
            tone: 'error',
            action: {
              label: '다시 시도',
              altText: '업로드 화면에서 다시 시도',
              onClick: () => undefined,
            },
          })
        }
      >
        Error + action
      </Button>
    </div>
  );
}

export const Toast: Story = {
  render: () => (
    <ToastProvider>
      <ToastDemo />
    </ToastProvider>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Toasts are announced politely (errors assertively), pause on hover/focus, can be ' +
          'swiped or dismissed with Escape, and the region is reachable with F8.',
      },
    },
  },
};

export const Modal: Story = {
  name: 'ModalDialog',
  render: () => (
    <ModalDialog
      defaultOpen
      trigger={<Button>Workspace 보관</Button>}
      title="Workspace를 보관할까요?"
      description="보관된 Workspace는 읽기 전용이 됩니다."
      footer={
        <>
          <DialogClose asChild>
            <Button>취소</Button>
          </DialogClose>
          <Button variant="primary">보관</Button>
        </>
      }
    >
      언제든지 보관 해제할 수 있습니다.
    </ModalDialog>
  ),
};

export const ModalForcedChoice: Story = {
  name: 'ModalDialog (no close button, no backdrop close)',
  render: () => (
    <ModalDialog
      defaultOpen
      size="sm"
      closeLabel={null}
      closeOnBackdropClick={false}
      trigger={<Button>세션 만료</Button>}
      title="세션이 만료되었습니다"
      footer={<Button variant="primary">다시 로그인</Button>}
    >
      계속하려면 다시 로그인하세요.
    </ModalDialog>
  ),
};
