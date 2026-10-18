import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  AppShell,
  Button,
  DialogClose,
  EmptyState,
  FloatingSidePanel,
  ModalDialog,
  PageHeader,
  Tooltip,
  ToastProvider,
  useToast,
} from '../src';

describe('AppShell', () => {
  function Shell() {
    return (
      <AppShell header={<span>Quiz Workspace</span>} sidebar={<a href="#docs">문서</a>}>
        <PageHeader title="문서" actions={<Button>업로드</Button>} />
      </AppShell>
    );
  }

  it('renders header, navigation and main landmarks with a skip link', () => {
    render(<Shell />);
    // The first banner is the app header; PageHeader's <header> lives inside <main>.
    expect(screen.getAllByRole('banner')[0]).toHaveTextContent('Quiz Workspace');
    expect(screen.getByRole('navigation', { name: '주 메뉴' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { level: 1, name: '문서' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '본문으로 건너뛰기' })).toHaveAttribute(
      'href',
      `#${main.id}`,
    );
  });

  it('opens the mobile drawer from the menu button and returns focus on Escape', async () => {
    const user = userEvent.setup();
    render(<Shell />);
    const menu = screen.getByRole('button', { name: '메뉴 열기' });
    await user.click(menu);
    const drawer = await screen.findByRole('dialog', { name: '주 메뉴' });
    expect(within(drawer).getByRole('link', { name: '문서' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(menu).toHaveFocus();
  });

  it('omits navigation and the menu button without a sidebar', () => {
    render(<AppShell header={<span>Quiz</span>}>본문</AppShell>);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '메뉴 열기' })).not.toBeInTheDocument();
  });
});

describe('ModalDialog', () => {
  it('traps focus, closes from a footer action and restores focus', async () => {
    const user = userEvent.setup();
    render(
      <ModalDialog
        title="Workspace 보관"
        trigger={<Button>보관</Button>}
        footer={
          <DialogClose asChild>
            <Button>취소</Button>
          </DialogClose>
        }
      >
        보관하면 읽기 전용이 됩니다.
      </ModalDialog>,
    );
    const trigger = screen.getByRole('button', { name: '보관' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Workspace 보관' });
    for (let i = 0; i < 4; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    await user.click(within(dialog).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});

describe('EmptyState', () => {
  it('renders a heading at the requested level with its action', () => {
    render(
      <EmptyState headingLevel={3} title="문제가 없습니다" action={<Button>문제 만들기</Button>} />,
    );
    expect(screen.getByRole('heading', { level: 3, name: '문제가 없습니다' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '문제 만들기' })).toBeInTheDocument();
  });
});

describe('Toast', () => {
  function Notify() {
    const { toast } = useToast();
    return (
      <Button onClick={() => toast({ title: '링크를 복사했습니다', tone: 'success' })}>복사</Button>
    );
  }

  it('announces a toast and dismisses it with the close button', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Notify />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: '복사' }));
    const title = await screen.findByText('링크를 복사했습니다', { selector: '.qz-toast__title' });
    const toast = title.closest('li');
    expect(toast).toHaveAttribute('data-tone', 'success');
    expect(screen.getByRole('region', { name: /알림/ })).toContainElement(toast);
    await user.click(within(toast as HTMLElement).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByText('링크를 복사했습니다')).not.toBeInTheDocument());
  });
});

describe('layering', () => {
  it('lifts tooltips opened inside a side panel above the panel layer', async () => {
    render(
      <FloatingSidePanel defaultOpen modal={false} title="발췌">
        <Tooltip content="원문 위치" open>
          <Button>위치</Button>
        </Tooltip>
      </FloatingSidePanel>,
    );
    const tooltip = await screen.findByRole('tooltip');
    // Radix renders the styled content next to a visually hidden role="tooltip" copy.
    const content = document.querySelector('.qz-tooltip');
    expect(tooltip).toBeInTheDocument();
    expect(content).toHaveStyle({ zIndex: 'calc(var(--z-side-panel) + 1)' });
  });
});
