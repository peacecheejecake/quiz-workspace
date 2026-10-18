import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Button, FloatingSidePanel, Input, ModalDialog } from '../src';

describe('FloatingSidePanel container', () => {
  it('portals into the given element so the panel stays in that landmark', async () => {
    function InMain() {
      const [main, setMain] = useState<HTMLElement | null>(null);
      return (
        <main ref={setMain}>
          {main ? (
            <FloatingSidePanel defaultOpen modal={false} title="공유 링크" container={main}>
              <Button>링크 만들기</Button>
            </FloatingSidePanel>
          ) : null}
        </main>
      );
    }
    render(<InMain />);
    const dialog = await screen.findByRole('dialog', { name: '공유 링크' });
    expect(screen.getByRole('main')).toContainElement(dialog);
  });

  it('adds no banner/contentinfo landmark next to the page header (M7.2 axe)', async () => {
    render(
      <FloatingSidePanel
        defaultOpen
        modal={false}
        title="발췌"
        footer={<Button>닫기</Button>}
        headerActions={<Button size="sm">PDF</Button>}
      >
        본문
      </FloatingSidePanel>,
    );
    const dialog = await screen.findByRole('dialog', { name: '발췌' });
    expect(dialog.querySelector('header, footer')).toBeNull();
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByRole('contentinfo')).toBeNull();
  });
});

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
    expect(dialog.querySelector('.qz-panel__header')).toContainElement(
      screen.getByRole('button', { name: '즐겨찾기' }),
    );
    expect(dialog.querySelector('.qz-panel__footer')).toContainElement(
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

describe('overlay body scroll region (axe scrollable-region-focusable)', () => {
  // jsdom has no layout: bodies report 600px of content in a 200px box unless marked short.
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.querySelector('[data-short]') ? 100 : 600;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 200,
    });
  });
  afterEach(() => {
    if (scrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight);
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
  });

  const bodyOf = (dialog: HTMLElement) =>
    dialog.querySelector<HTMLElement>('.qz-panel__body, .qz-modal__body');

  it('makes a long body without focusable content a named, keyboard-reachable group', async () => {
    const user = userEvent.setup();
    render(
      <FloatingSidePanel defaultOpen modal={false} title="원문 발췌">
        <p>긴 발췌 본문</p>
      </FloatingSidePanel>,
    );
    const dialog = await screen.findByRole('dialog', { name: '원문 발췌' });
    const body = await screen.findByRole('group', { name: '원문 발췌' });
    expect(body).toBe(bodyOf(dialog));
    expect(body).toHaveAttribute('tabindex', '0');
    await user.tab();
    await user.tab();
    expect(body).toHaveFocus();
  });

  it('keeps short bodies and bodies with focusable content out of the tab order', async () => {
    render(
      <>
        <FloatingSidePanel defaultOpen modal={false} title="짧은 패널">
          <p data-short>짧은 본문</p>
        </FloatingSidePanel>
        <FloatingSidePanel defaultOpen modal={false} title="버튼 패널">
          <Button>원문으로 이동</Button>
        </FloatingSidePanel>
      </>,
    );
    for (const name of ['짧은 패널', '버튼 패널']) {
      const body = bodyOf(await screen.findByRole('dialog', { name }));
      expect(body).not.toHaveAttribute('tabindex');
      expect(body).not.toHaveAttribute('role');
    }
  });

  it('follows content changes: focusable once its only control goes away', async () => {
    function Toggle() {
      const [withButton, setWithButton] = useState(true);
      return (
        <FloatingSidePanel defaultOpen modal={false} title="발췌">
          {withButton ? <Button onClick={() => setWithButton(false)}>숨기기</Button> : <p>본문</p>}
        </FloatingSidePanel>
      );
    }
    const user = userEvent.setup();
    render(<Toggle />);
    const body = bodyOf(await screen.findByRole('dialog', { name: '발췌' }));
    expect(body).not.toHaveAttribute('tabindex');
    await user.click(screen.getByRole('button', { name: '숨기기' }));
    await waitFor(() => expect(body).toHaveAttribute('tabindex', '0'));
  });

  it('applies to ModalDialog bodies too', async () => {
    render(
      <ModalDialog defaultOpen title="안내" closeLabel={null}>
        <p>긴 안내문</p>
      </ModalDialog>,
    );
    const dialog = await screen.findByRole('dialog', { name: '안내' });
    await waitFor(() => expect(bodyOf(dialog)).toHaveAttribute('tabindex', '0'));
    expect(screen.getByRole('group', { name: '안내' })).toBe(bodyOf(dialog));
  });
});
