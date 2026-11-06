import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('FloatingSidePanel side and size', () => {
  it('floats at the end edge by default and at the start edge with side="start"', async () => {
    render(
      <>
        <FloatingSidePanel defaultOpen modal={false} title="발췌">
          본문
        </FloatingSidePanel>
        <FloatingSidePanel defaultOpen modal={false} title="목차" side="start" size="narrow">
          목차 본문
        </FloatingSidePanel>
      </>,
    );
    const end = await screen.findByRole('dialog', { name: '발췌' });
    const start = await screen.findByRole('dialog', { name: '목차' });
    expect(end).toHaveAttribute('data-side', 'end');
    expect(end).toHaveAttribute('data-size', 'default');
    expect(start).toHaveAttribute('data-side', 'start');
    expect(start).toHaveAttribute('data-size', 'narrow');
  });
});

describe('FloatingSidePanel (modal)', () => {
  it('reports the resolved mouse opener even when a click does not move focus', async () => {
    const received = vi.fn();
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>열기</button>
          <FloatingSidePanel
            open={open}
            onOpenChange={setOpen}
            title="패널"
            onOpenerResolved={received}
          >
            내용
          </FloatingSidePanel>
        </>
      );
    }
    render(<Example />);
    const opener = screen.getByRole('button', { name: '열기' });
    expect(document.activeElement).not.toBe(opener);
    fireEvent.click(opener);
    await screen.findByRole('dialog', { name: '패널' });
    expect(received).toHaveBeenCalledWith(opener);
  });
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
    expect(dialog.querySelector(':scope > .header')).toContainElement(
      screen.getByRole('button', { name: '즐겨찾기' }),
    );
    expect(dialog.querySelector(':scope > .footer')).toContainElement(
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

describe('FloatingSidePanel Escape with a modal panel under a non-modal one', () => {
  // Radix lets only the layer it ranks highest handle Escape. A non-modal panel ranked above the
  // modal panel that holds focus (CHNOTE-01-AC02: the 정리 노트 panel while the practice panel
  // opened from its footnote) declines it; the modal panel must still close.
  function Stacked() {
    const [modalOpen, setModalOpen] = useState(true);
    const [noteOpen, setNoteOpen] = useState(false);
    return (
      <>
        <FloatingSidePanel open={modalOpen} onOpenChange={setModalOpen} title="2번 문제">
          <Button onClick={() => setNoteOpen(true)}>노트 열기</Button>
        </FloatingSidePanel>
        <FloatingSidePanel
          open={noteOpen}
          onOpenChange={setNoteOpen}
          modal={false}
          title="정리 노트"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          본문
        </FloatingSidePanel>
      </>
    );
  }

  it('closes the focused modal panel', async () => {
    const user = userEvent.setup();
    render(<Stacked />);
    const modal = await screen.findByRole('dialog', { name: '2번 문제' });
    await user.click(screen.getByRole('button', { name: '노트 열기' }));
    expect(await screen.findByRole('dialog', { name: '정리 노트', hidden: true })).toBeTruthy();
    expect(modal).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '2번 문제', hidden: true })).toBeNull(),
    );
    expect(screen.getByRole('dialog', { name: '정리 노트' })).toBeInTheDocument();
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

  const bodyOf = (dialog: HTMLElement) => dialog.querySelector<HTMLElement>(':scope > .body');

  it('UX12-VIEW-AC06 brings the body to the top when scrollKey changes, and only then', async () => {
    const panel = (scrollKey: string | undefined, label: string) => (
      <FloatingSidePanel open title="스크롤" scrollKey={scrollKey}>
        <p>{label}</p>
      </FloatingSidePanel>
    );
    const view = render(panel('a', '첫째'));
    const body = bodyOf(await screen.findByRole('dialog', { name: '스크롤' }));
    if (!body) throw new Error('no body');
    body.scrollTop = 120;
    view.rerender(panel('a', '내용만 바뀜'));
    expect(body.scrollTop).toBe(120);
    view.rerender(panel(undefined, '닫히는 중'));
    expect(body.scrollTop).toBe(120);
    view.rerender(panel('b', '둘째'));
    expect(body.scrollTop).toBe(0);
  });

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

  it('follows content that becomes inert (a covered panel): focusable once nothing in it is', async () => {
    function Covered() {
      const [covered, setCovered] = useState(false);
      return (
        <FloatingSidePanel defaultOpen modal={false} title="덮인 패널">
          <div inert={covered || undefined}>
            <Button>원문으로 이동</Button>
            <button type="button" onClick={() => setCovered(true)} data-cover>
              덮기
            </button>
          </div>
        </FloatingSidePanel>
      );
    }
    const user = userEvent.setup();
    render(<Covered />);
    const body = bodyOf(await screen.findByRole('dialog', { name: '덮인 패널' }));
    expect(body).not.toHaveAttribute('tabindex');
    await user.click(screen.getByText('덮기'));
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

/** DOC-02-like host: a bar toggle outside the panel and a positioned split container. */
function DockedOutline(props: {
  initialOpen: boolean;
  dockMode?: 'inset' | 'overlay';
  modal?: boolean;
  focusTreeOnOpen?: boolean;
}) {
  const [open, setOpen] = useState(props.initialOpen);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <main>
      <div role="group" aria-label="보기 설정">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="outline-panel"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '목차 접기' : '목차 펼치기'}
        </button>
      </div>
      <div ref={setHost} data-testid="split-host" style={{ position: 'relative' }}>
        <button type="button">원본 내용</button>
      </div>
      <FloatingSidePanel
        id="outline-panel"
        side="start"
        placement="docked"
        dockMode={props.dockMode}
        modal={props.modal}
        container={host}
        open={open}
        onOpenChange={setOpen}
        title="목차"
        closeLabel="목차 접기"
        onOpenAutoFocus={
          props.focusTreeOnOpen
            ? (event) => {
                event.preventDefault();
                document.getElementById('first-item')?.focus();
              }
            : undefined
        }
      >
        <ul role="tree" aria-label="문서 목차">
          <li role="treeitem" id="first-item" tabIndex={0} aria-selected="false">
            1장
          </li>
        </ul>
      </FloatingSidePanel>
    </main>
  );
}

describe('FloatingSidePanel side="start" placement="docked"', () => {
  it('docks non-modally inside the container and makes room for itself (inset)', async () => {
    render(<DockedOutline initialOpen modal />);
    const dialog = await screen.findByRole('dialog', { name: '목차' });
    const host = screen.getByTestId('split-host');
    expect(host).toContainElement(dialog);
    expect(dialog).toHaveAttribute('data-side', 'start');
    expect(dialog).toHaveAttribute('data-placement', 'docked');
    expect(dialog).toHaveAttribute('data-dock-mode', 'inset');
    // A docked panel is always the narrow navigation column (--outline-panel-width).
    expect(dialog).toHaveAttribute('data-size', 'narrow');
    expect(dialog).toHaveAttribute('id', 'outline-panel');
    // `modal` is ignored for docked panels: no aria-modal, no backdrop, background reachable.
    expect(dialog).not.toHaveAttribute('aria-modal');
    expect(document.querySelector('.qz-backdrop')).toBeNull();
    expect(screen.getByRole('button', { name: '원본 내용' })).toBeVisible();
    expect(host).toHaveAttribute('data-qz-dock-inset', 'start');

    await userEvent.click(screen.getByRole('button', { name: '목차 접기', expanded: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(host).not.toHaveAttribute('data-qz-dock-inset');
  });

  it('overlay mode leaves the container untouched', async () => {
    render(<DockedOutline initialOpen dockMode="overlay" />);
    const dialog = await screen.findByRole('dialog', { name: '목차' });
    expect(dialog).toHaveAttribute('data-dock-mode', 'overlay');
    expect(screen.getByTestId('split-host')).not.toHaveAttribute('data-qz-dock-inset');
  });

  it('does not move focus when it mounts open (restored state)', async () => {
    const before = document.createElement('button');
    before.textContent = '이전 focus';
    document.body.append(before);
    before.focus();
    render(<DockedOutline initialOpen focusTreeOnOpen />);
    await screen.findByRole('dialog', { name: '목차' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(before).toHaveFocus();
    before.remove();
  });

  it('moves focus in when the user opens it, and Escape inside collapses back to the toggle', async () => {
    const user = userEvent.setup();
    render(<DockedOutline initialOpen={false} focusTreeOnOpen />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: '목차 펼치기' }));
    await screen.findByRole('dialog', { name: '목차' });
    await waitFor(() => expect(screen.getByRole('treeitem', { name: '1장' })).toHaveFocus());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: '목차 펼치기' })).toHaveFocus();
  });

  it('Escape with focus outside the panel keeps it open', async () => {
    const user = userEvent.setup();
    render(<DockedOutline initialOpen />);
    await screen.findByRole('dialog', { name: '목차' });
    screen.getByRole('button', { name: '원본 내용' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '목차' })).toBeInTheDocument();
  });

  it('restored open: Escape inside returns focus to the aria-controls toggle', async () => {
    const user = userEvent.setup();
    render(<DockedOutline initialOpen />);
    await screen.findByRole('dialog', { name: '목차' });
    screen.getByRole('treeitem', { name: '1장' }).focus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: '목차 펼치기' })).toHaveFocus();
  });

  it('is not rendered until its container exists', () => {
    render(
      <FloatingSidePanel open placement="docked" side="start" container={null} title="목차">
        내용
      </FloatingSidePanel>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('defaults stay end / viewport', async () => {
    render(
      <FloatingSidePanel defaultOpen modal={false} title="발췌">
        본문
      </FloatingSidePanel>,
    );
    const dialog = await screen.findByRole('dialog', { name: '발췌' });
    expect(dialog).toHaveAttribute('data-side', 'end');
    expect(dialog).toHaveAttribute('data-placement', 'viewport');
    expect(dialog).not.toHaveAttribute('data-dock-mode');
    expect(document.body).toContainElement(dialog);
  });
});

describe('FloatingSidePanel id', () => {
  it('keeps the Radix content id (trigger aria-controls) when no id is given', async () => {
    render(
      <FloatingSidePanel modal={false} title="발췌" trigger={<Button>발췌 열기</Button>}>
        본문
      </FloatingSidePanel>,
    );
    await userEvent.click(screen.getByRole('button', { name: '발췌 열기' }));
    const dialog = await screen.findByRole('dialog', { name: '발췌' });
    expect(dialog.id).not.toBe('');
    expect(screen.getByRole('button', { name: '발췌 열기' })).toHaveAttribute(
      'aria-controls',
      dialog.id,
    );
  });
});

describe('FloatingSidePanel id with a trigger', () => {
  it('points the trigger aria-controls at the explicit id', async () => {
    render(
      <FloatingSidePanel
        id="excerpt-panel"
        modal={false}
        title="발췌"
        trigger={<Button>발췌 열기</Button>}
      >
        본문
      </FloatingSidePanel>,
    );
    const trigger = screen.getByRole('button', { name: '발췌 열기' });
    expect(trigger).not.toHaveAttribute('aria-controls');
    await userEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: '발췌' });
    expect(dialog).toHaveAttribute('id', 'excerpt-panel');
    expect(trigger).toHaveAttribute('aria-controls', 'excerpt-panel');
  });
});

describe('Escape inside an inline edit control marked data-own-escape (MOCK-ESC)', () => {
  // An inline rename inside a dialog: Escape cancels the rename and returns focus to the
  // button that started it; only the next Escape closes the dialog. Radix handles Escape on the
  // document in the capture phase, before the field's own keydown handler runs.
  function InlineRename() {
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState('중간 점검');
    const [draft, setDraft] = useState(name);
    const start = useRef<HTMLButtonElement>(null);
    const stopped = useRef(false);
    const field = useRef<HTMLInputElement>(null);
    useEffect(() => {
      if (editing) field.current?.focus();
      else if (stopped.current) start.current?.focus();
    }, [editing]);
    const stop = () => {
      stopped.current = true;
      setEditing(false);
    };
    return editing ? (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setName(draft);
          stop();
        }}
      >
        <input
          ref={field}
          aria-label="이름"
          data-own-escape=""
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setDraft(name);
            stop();
          }}
        />
        <button type="submit">저장</button>
      </form>
    ) : (
      <>
        <p>{name}</p>
        <button ref={start} type="button" onClick={() => setEditing(true)}>
          이름 바꾸기
        </button>
      </>
    );
  }

  async function cancelThenClose(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(screen.getByRole('button', { name: '이름 바꾸기' }));
    const field = screen.getByRole('textbox', { name: '이름' });
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, '기말 대비');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: '이름' })).not.toBeInTheDocument();
    expect(screen.getByText('중간 점검')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '이름 바꾸기' })).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name })).not.toBeInTheDocument());
  }

  it('cancels only the edit in a non-modal FloatingSidePanel; the next Escape closes it', async () => {
    const user = userEvent.setup();
    render(
      <FloatingSidePanel defaultOpen modal={false} title="모의고사">
        <InlineRename />
      </FloatingSidePanel>,
    );
    await screen.findByRole('dialog', { name: '모의고사' });
    await cancelThenClose(user, '모의고사');
  });

  it('cancels only the edit in a modal FloatingSidePanel; the next Escape closes it', async () => {
    const user = userEvent.setup();
    render(
      <FloatingSidePanel defaultOpen title="모의고사">
        <InlineRename />
      </FloatingSidePanel>,
    );
    await screen.findByRole('dialog', { name: '모의고사' });
    await cancelThenClose(user, '모의고사');
  });

  it('cancels only the edit in a ModalDialog; the next Escape closes it', async () => {
    const user = userEvent.setup();
    render(
      <ModalDialog defaultOpen title="문제 편집">
        <InlineRename />
      </ModalDialog>,
    );
    await screen.findByRole('dialog', { name: '문제 편집' });
    await cancelThenClose(user, '문제 편집');
  });

  it('keeps a modal panel open under a non-modal panel ranked above it', async () => {
    // The non-modal panel declines Escape (focus is not inside it) and the focused modal panel
    // closes itself for declined presses, except when the press belongs to an inline edit.
    function Stacked() {
      const [noteOpen, setNoteOpen] = useState(false);
      return (
        <>
          <FloatingSidePanel defaultOpen title="2번 문제">
            <Button onClick={() => setNoteOpen(true)}>노트 열기</Button>
            <InlineEditWithoutStop />
          </FloatingSidePanel>
          <FloatingSidePanel
            open={noteOpen}
            onOpenChange={setNoteOpen}
            modal={false}
            title="정리 노트"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            본문
          </FloatingSidePanel>
        </>
      );
    }
    /** An inline edit whose Escape handler does not stop propagation. */
    function InlineEditWithoutStop() {
      const [editing, setEditing] = useState(true);
      return editing ? (
        <input
          aria-label="이름"
          data-own-escape=""
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <p>편집 취소됨</p>
      );
    }
    const user = userEvent.setup();
    render(<Stacked />);
    await screen.findByRole('dialog', { name: '2번 문제' });
    await user.click(screen.getByRole('button', { name: '노트 열기' }));
    await screen.findByRole('dialog', { name: '정리 노트', hidden: true });
    await user.click(screen.getByRole('textbox', { name: '이름', hidden: true }));
    await user.keyboard('{Escape}');
    expect(screen.getByText('편집 취소됨')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '2번 문제', hidden: true })).toBeInTheDocument();
  });
});
