import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../src';

describe('Tabs', () => {
  it('exposes tabs/tabpanel roles and moves selection with the arrow keys', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="active">
        <TabsList aria-label="Workspace 상태">
          <TabsTrigger value="active">활성</TabsTrigger>
          <TabsTrigger value="archived">보관됨</TabsTrigger>
        </TabsList>
        <TabsContent value="active">활성 목록</TabsContent>
        <TabsContent value="archived">보관 목록</TabsContent>
      </Tabs>,
    );
    const active = screen.getByRole('tab', { name: '활성' });
    expect(active).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('활성 목록');
    await user.click(active);
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '보관됨' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: '보관됨' })).toHaveTextContent('보관 목록');
  });
});

describe('DropdownMenu', () => {
  it('opens a menu from its trigger and runs the chosen item', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>더보기</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label="작업">
          <DropdownMenuItem onSelect={onArchive}>보관</DropdownMenuItem>
          <DropdownMenuItem tone="danger">삭제</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const trigger = screen.getByRole('button', { name: '더보기' });
    await user.click(trigger);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: '삭제' })).toHaveAttribute(
      'data-tone',
      'danger',
    );
    await user.click(within(menu).getByRole('menuitem', { name: '보관' }));
    expect(onArchive).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });
});

describe('ConfirmDialog', () => {
  function Harness({ onConfirm }: { onConfirm: () => void }) {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    return (
      <>
        <Button ref={triggerRef} onClick={() => setOpen(true)}>
          삭제
        </Button>
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="Workspace 삭제"
          description="삭제하면 되돌릴 수 없습니다."
          confirmLabel="삭제"
          returnFocusRef={triggerRef}
          onConfirm={() => {
            onConfirm();
            setOpen(false);
          }}
        />
      </>
    );
  }

  it('is an alertdialog that starts on cancel and confirms explicitly', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const trigger = screen.getByRole('button', { name: '삭제' });
    await user.click(trigger);
    const dialog = await screen.findByRole('alertdialog', { name: 'Workspace 삭제' });
    expect(within(dialog).getByRole('button', { name: '취소' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    const again = await screen.findByRole('alertdialog');
    await user.click(within(again).getByRole('button', { name: '삭제' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });
});
