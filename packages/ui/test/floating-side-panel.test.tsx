import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Button, FloatingSidePanel, Input } from '../src';

function ModalPanel(props: { closeOnBackdropClick?: boolean }) {
  return (
    <>
      <button type="button">배경 버튼</button>
      <FloatingSidePanel
        title="문제 3"
        description="객관식"
        trigger={<Button>문제 열기</Button>}
        footer={<Button variant="primary">제출</Button>}
        headerActions={<Button size="sm">즐겨찾기</Button>}
        {...props}
      >
        <Input label="답" />
      </FloatingSidePanel>
    </>
  );
}

/** Opened from a plain control (e.g. a heatmap dot) instead of a Radix trigger. */
function ControlledNonModalPanel() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <main>
        <button type="button" onClick={() => setOpen(true)}>
          발췌 열기
        </button>
        <label>
          검색어
          <input />
        </label>
      </main>
      <FloatingSidePanel open={open} onOpenChange={setOpen} modal={false} title="발췌">
        <Button>원문으로 이동</Button>
      </FloatingSidePanel>
    </>
  );
}

describe('FloatingSidePanel (modal)', () => {
  it('traps focus, closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<ModalPanel />);
    const trigger = screen.getByRole('button', { name: '문제 열기' });

    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: '문제 3' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('객관식');
    expect(dialog).toHaveFocus();

    // Cycle through more tab stops than the panel has, both directions: focus never leaves.
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < 8; i++) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('hides the background from assistive technology while open', async () => {
    const user = userEvent.setup();
    render(<ModalPanel />);
    await user.click(screen.getByRole('button', { name: '문제 열기' }));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: '배경 버튼' })).not.toBeInTheDocument();
  });

  it('closes via the close button and returns focus', async () => {
    const user = userEvent.setup();
    render(<ModalPanel />);
    const trigger = screen.getByRole('button', { name: '문제 열기' });
    await user.click(trigger);
    await user.click(await screen.findByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('renders header actions and footer slots', async () => {
    const user = userEvent.setup();
    render(<ModalPanel />);
    await user.click(screen.getByRole('button', { name: '문제 열기' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('header')).toContainElement(
      screen.getByRole('button', { name: '즐겨찾기' }),
    );
    expect(dialog.querySelector('footer')).toContainElement(
      screen.getByRole('button', { name: '제출' }),
    );
  });
});

describe('FloatingSidePanel (non-modal)', () => {
  it('lets focus and clicks move to background content without closing', async () => {
    const user = userEvent.setup();
    render(<ControlledNonModalPanel />);
    const opener = screen.getByRole('button', { name: '발췌 열기' });

    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: '발췌' });
    expect(dialog).not.toHaveAttribute('aria-modal');
    expect(dialog).toHaveFocus();

    // Keyboard: Shift+Tab from the panel goes back to the opener (no trap) ...
    await user.tab({ shift: true });
    expect(opener).toHaveFocus();
    // ... Tab continues through the page in document order ...
    await user.tab();
    expect(screen.getByRole('textbox', { name: '검색어' })).toHaveFocus();
    // ... and Tab past the panel's last control returns to the page after the opener.
    screen.getByRole('button', { name: '원문으로 이동' }).focus();
    await user.tab();
    expect(dialog).not.toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole('textbox', { name: '검색어' })).toHaveFocus();

    // Pointer: typing in the background keeps the panel open.
    await user.click(screen.getByRole('textbox', { name: '검색어' }));
    await user.keyboard('정의');
    expect(screen.getByRole('textbox', { name: '검색어' })).toHaveValue('정의');
    expect(screen.getByRole('dialog', { name: '발췌' })).toBeInTheDocument();

    // Escape belongs to the background widget while focus is there.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '발췌' })).toBeInTheDocument();
  });

  it('closes on Escape from inside the panel and returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<ControlledNonModalPanel />);
    const opener = screen.getByRole('button', { name: '발췌 열기' });
    await user.click(opener);
    await screen.findByRole('dialog');
    await user.tab();
    expect(screen.getByRole('button', { name: '닫기' })).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});

describe('FloatingSidePanel (non-modal) focus handoff skips unfocusable candidates', () => {
  function PanelWithHiddenNeighbours() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <main>
          <button type="button" onClick={() => setOpen(true)}>
            발췌 열기
          </button>
          <button type="button" style={{ display: 'none' }}>
            숨은 버튼
          </button>
          <nav aria-label="모바일 메뉴" style={{ display: 'none' }}>
            <a href="#docs">숨은 링크</a>
          </nav>
          <div hidden>
            <button type="button">hidden 속성</button>
          </div>
          <button type="button" style={{ visibility: 'hidden' }}>
            보이지 않음
          </button>
          <div inert>
            <button type="button">inert 버튼</button>
          </div>
          <button type="button">거부하는 버튼</button>
          <button type="button">다음 버튼</button>
        </main>
        <FloatingSidePanel open={open} onOpenChange={setOpen} modal={false} title="발췌">
          <Button>원문으로 이동</Button>
        </FloatingSidePanel>
      </>
    );
  }

  it('moves Tab focus to the next element that actually takes focus', async () => {
    const user = userEvent.setup();
    render(<PanelWithHiddenNeighbours />);
    // A candidate whose focus() does nothing (e.g. hidden by CSS the engine cannot report).
    const refusing = screen.getByRole('button', { name: '거부하는 버튼' });
    refusing.focus = () => undefined;

    await user.click(screen.getByRole('button', { name: '발췌 열기' }));
    const dialog = await screen.findByRole('dialog', { name: '발췌' });
    screen.getByRole('button', { name: '원문으로 이동' }).focus();
    await user.tab();

    expect(dialog).not.toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole('button', { name: '다음 버튼' })).toHaveFocus();
  });

  it('Shift+Tab skips an opener that became hidden and lands on the element before it', async () => {
    function HidingOpener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button">앞 버튼</button>
          {/* e.g. a responsive nav that collapses once the panel opens */}
          <div style={{ display: open ? 'none' : 'block' }}>
            <button type="button" onClick={() => setOpen(true)}>
              발췌 열기
            </button>
          </div>
          <FloatingSidePanel open={open} onOpenChange={setOpen} modal={false} title="발췌">
            <Button>원문으로 이동</Button>
          </FloatingSidePanel>
        </>
      );
    }
    const user = userEvent.setup();
    render(<HidingOpener />);
    await user.click(screen.getByRole('button', { name: '발췌 열기' }));
    const dialog = await screen.findByRole('dialog', { name: '발췌' });
    expect(dialog).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '앞 버튼' })).toHaveFocus();
  });
});
