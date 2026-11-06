import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AppShell, FloatingSidePanel, ModalDialog, useDragDismiss } from '../src';

function pointer(target: Window | Element, type: string, props: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true });
  Object.assign(
    event,
    { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 0, clientY: 0 },
    props,
  );
  fireEvent(target, event);
}
function Example() {
  const [open, setOpen] = useState(true);
  return (
    <ModalDialog open={open} onOpenChange={setOpen} title="대화">
      <button>본문</button>
    </ModalDialog>
  );
}

describe('overlay gesture', () => {
  it('UX10-UI-AC03 closes from the header downward', () => {
    render(<Example />);
    const dialog = screen.getByRole('dialog');
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 900,
      top: 100,
      bottom: 668,
      width: 800,
      height: 568,
      x: 100,
      y: 100,
      toJSON() {
        return {};
      },
    });
    const header = dialog.querySelector('.header');
    if (!header) throw new Error('missing header');
    pointer(header, 'pointerdown', { clientY: 100 });
    pointer(window, 'pointerup', { clientY: 180 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('UX10-UI-AC04 ignores body starts, cancellation and multiple touches', () => {
    render(<Example />);
    const dialog = screen.getByRole('dialog');
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 900,
      top: 100,
      bottom: 668,
      width: 800,
      height: 568,
      x: 100,
      y: 100,
      toJSON() {
        return {};
      },
    });
    const header = dialog.querySelector('.header');
    if (!header) throw new Error('missing header');
    pointer(screen.getByRole('button', { name: '본문' }), 'pointerdown', {});
    pointer(window, 'pointerup', { clientY: 100 });
    pointer(header, 'pointerdown', {});
    pointer(window, 'pointercancel', {});
    pointer(window, 'pointerup', { clientY: 100 });
    pointer(header, 'pointerdown', {});
    pointer(window, 'pointerdown', { pointerId: 2, isPrimary: false });
    pointer(window, 'pointerup', { clientY: 100 });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

it('UX10-UI-AC03 only the top overlay handles a swipe', () => {
  function Nested() {
    const [outer, setOuter] = useState(true);
    const [inner, setInner] = useState(true);
    return (
      <ModalDialog open={outer} onOpenChange={setOuter} title="바깥">
        <ModalDialog open={inner} onOpenChange={setInner} title="안쪽">
          내용
        </ModalDialog>
      </ModalDialog>
    );
  }
  render(<Nested />);
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
  expect(dialogs).toHaveLength(2);
  const inner = dialogs[1];
  if (!inner) throw new Error('missing inner dialog');
  vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    right: 900,
    top: 100,
    bottom: 668,
    width: 800,
    height: 568,
    x: 100,
    y: 100,
    toJSON() {
      return {};
    },
  });
  const header = inner.querySelector('.header');
  if (!header) throw new Error('missing header');
  pointer(header, 'pointerdown', {});
  pointer(window, 'pointerup', { clientY: 100 });
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(screen.getByRole('dialog', { name: '바깥' })).toBeInTheDocument();
});

it('UX10-UI-AC04 resize cancels an active pen gesture', () => {
  render(<Example />);
  const dialog = screen.getByRole('dialog');
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    right: 900,
    top: 100,
    bottom: 668,
    width: 800,
    height: 568,
    x: 100,
    y: 100,
    toJSON() {
      return {};
    },
  });
  const header = dialog.querySelector('.header');
  if (!header) throw new Error('missing header');
  pointer(header, 'pointerdown', { pointerType: 'pen' });
  fireEvent(window, new Event('resize'));
  pointer(window, 'pointerup', { pointerType: 'pen', clientY: 100 });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('UX10-UI-AC03 pen gesture closes under reduced motion', () => {
  const original = window.matchMedia;
  window.matchMedia = (query) => ({
    ...original(query),
    matches: query.includes('prefers-reduced-motion'),
  });
  try {
    render(<Example />);
    const dialog = screen.getByRole('dialog');
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 900,
      top: 100,
      bottom: 668,
      width: 800,
      height: 568,
      x: 100,
      y: 100,
      toJSON() {
        return {};
      },
    });
    const header = dialog.querySelector('.header');
    if (!header) throw new Error('missing header');
    pointer(header, 'pointerdown', { pointerType: 'pen' });
    pointer(window, 'pointerup', { pointerType: 'pen', clientY: 100 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  } finally {
    window.matchMedia = original;
  }
});

const FULL_WIDTH_RECT = {
  left: 8,
  right: 382,
  top: 200,
  bottom: 500,
  width: 374,
  height: 300,
  x: 8,
  y: 200,
  toJSON() {
    return {};
  },
};

it('UX12-GESTURE-AC01 a dialog on a phone goes down, not to its nearest side edge', () => {
  render(<Example />);
  const dialog = screen.getByRole('dialog');
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(FULL_WIDTH_RECT);
  const title = screen.getByRole('heading', { name: '대화' });
  pointer(title, 'pointerdown', {});
  pointer(window, 'pointermove', { clientX: -12 });
  expect(dialog.style.translate).toBe('');
  pointer(window, 'pointerup', { clientX: -80 });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  pointer(title, 'pointerdown', {});
  pointer(window, 'pointermove', { clientY: 30 });
  expect(dialog.style.translate).toBe('0px 30px');
  expect(dialog).toHaveAttribute('data-dragging');
  pointer(window, 'pointermove', { clientY: 90 });
  expect(dialog.style.translate).toBe('0px 90px');
  pointer(window, 'pointerup', { clientY: 90 });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('UX12-GESTURE-AC03 controls in the header do not start a drag', () => {
  render(<Example />);
  const dialog = screen.getByRole('dialog');
  pointer(screen.getByRole('button', { name: '닫기' }), 'pointerdown', {});
  pointer(window, 'pointermove', { clientY: 30 });
  expect(dialog.style.translate).toBe('');
  pointer(window, 'pointerup', { clientY: 100 });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('UX12-GESTURE-AC04 the slop keeps a tap still and a mouse never drags', () => {
  render(<Example />);
  const dialog = screen.getByRole('dialog');
  const title = screen.getByRole('heading', { name: '대화' });
  pointer(title, 'pointerdown', {});
  pointer(window, 'pointermove', { clientY: 7 });
  expect(dialog.style.translate).toBe('');
  pointer(window, 'pointercancel', {});
  pointer(title, 'pointerdown', { pointerType: 'mouse' });
  pointer(window, 'pointermove', { pointerType: 'mouse', clientY: 40 });
  expect(dialog.style.translate).toBe('');
  pointer(window, 'pointerup', { pointerType: 'mouse', clientY: 100 });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('UX12-GESTURE-AC04 a drag across the dismiss axis is not tracked or dismissed', () => {
  render(<Example />);
  const dialog = screen.getByRole('dialog');
  const title = screen.getByRole('heading', { name: '대화' });
  pointer(title, 'pointerdown', {});
  pointer(window, 'pointermove', { clientX: 20 });
  pointer(window, 'pointermove', { clientX: 20, clientY: 120 });
  expect(dialog.style.translate).toBe('');
  pointer(window, 'pointerup', { clientX: 20, clientY: 120 });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('UX12-GESTURE-AC05 unsaved input refuses the swipe', () => {
  const onOpenChange = vi.fn();
  render(
    <ModalDialog open dirty onOpenChange={onOpenChange} title="대화">
      내용
    </ModalDialog>,
  );
  const dialog = screen.getByRole('dialog');
  pointer(screen.getByRole('heading', { name: '대화' }), 'pointerdown', {});
  pointer(window, 'pointermove', { clientY: 100 });
  pointer(window, 'pointerup', { clientY: 100 });
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(dialog.style.translate).toBe('');
  expect(dialog).not.toHaveAttribute('data-dragging');
});

it('UX12-GESTURE-AC02 a non-modal panel does not respond and has no grabber', () => {
  const onOpenChange = vi.fn();
  render(
    <FloatingSidePanel open modal={false} onOpenChange={onOpenChange} title="패널">
      내용
    </FloatingSidePanel>,
  );
  const panel = screen.getByRole('dialog');
  expect(panel.querySelector('.grabber')).toBeNull();
  pointer(screen.getByRole('heading', { name: '패널' }), 'pointerdown', {});
  pointer(window, 'pointermove', { clientX: 100 });
  pointer(window, 'pointerup', { clientX: 100 });
  expect(panel.style.translate).toBe('');
  expect(onOpenChange).not.toHaveBeenCalled();
});

it('UX12-GESTURE-AC08 a drag from a control swallows only the release click', () => {
  const pressed = vi.fn();
  const close = vi.fn();
  function Bar() {
    const surface = useRef<HTMLDivElement>(null);
    const start = useDragDismiss({ surface, edges: ['bottom'], startFrom: 'any', close });
    return (
      <div ref={surface} data-testid="bar" onPointerDown={start}>
        <button onClick={pressed}>버튼</button>
      </div>
    );
  }
  render(<Bar />);
  const button = screen.getByRole('button', { name: '버튼' });
  pointer(button, 'pointerdown', {});
  pointer(window, 'pointermove', { clientY: 20 });
  expect(screen.getByTestId('bar').style.translate).toBe('0px 20px');
  pointer(window, 'pointerup', { clientY: 20 });
  fireEvent.click(button);
  expect(pressed).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(pressed).toHaveBeenCalledTimes(1);

  pointer(button, 'pointerdown', {});
  pointer(window, 'pointerup', { clientY: 2 });
  fireEvent.click(button);
  expect(pressed).toHaveBeenCalledTimes(2);

  pointer(button, 'pointerdown', {});
  pointer(window, 'pointermove', { clientY: 90 });
  pointer(window, 'pointerup', { clientY: 90 });
  expect(close).toHaveBeenCalledTimes(1);
});

it('UX12-GESTURE-AC01 leaves with an animation, then closes; a refusal springs back', () => {
  const finish: (() => void)[] = [];
  const animate = vi.fn(() => {
    const animation = {
      onfinish: null as (() => void) | null,
      oncancel: null as (() => void) | null,
      cancel: vi.fn(),
    };
    finish.push(() => animation.onfinish?.());
    return animation;
  });
  const close = vi.fn((): false => false);
  function Sheet() {
    const surface = useRef<HTMLDivElement>(null);
    const start = useDragDismiss({ surface, edges: ['bottom'], close });
    return <div ref={surface} data-testid="sheet" onPointerDown={start} />;
  }
  render(<Sheet />);
  const sheet = screen.getByTestId('sheet');
  Object.assign(sheet, { animate });
  pointer(sheet, 'pointerdown', {});
  pointer(window, 'pointermove', { clientY: 100 });
  pointer(window, 'pointerup', { clientY: 100 });
  expect(sheet).toHaveAttribute('data-swiped');
  expect(animate).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
  finish[0]?.();
  expect(close).toHaveBeenCalledTimes(1);
  expect(animate).toHaveBeenCalledTimes(2);
  expect(sheet).not.toHaveAttribute('data-swiped');
  // A new gesture waits for the spring.
  pointer(sheet, 'pointerdown', {});
  pointer(window, 'pointermove', { clientY: 100 });
  expect(sheet.style.translate).toBe('');
  finish[1]?.();
  expect(sheet).not.toHaveAttribute('data-dragging');
  pointer(sheet, 'pointerdown', {});
  pointer(window, 'pointermove', { clientY: 30 });
  expect(sheet.style.translate).toBe('0px 30px');
});

it('UX12-GESTURE-AC02 the AppShell drawer swipes left from its title', () => {
  const onChange = vi.fn();
  render(
    <AppShell
      header="머리"
      sidebar={<a href="#a">문서</a>}
      mobileNavOpen
      onMobileNavOpenChange={onChange}
    >
      본문
    </AppShell>,
  );
  const drawer = screen.getByRole('dialog');
  const title = screen.getByRole('heading', { name: '주 메뉴' });
  pointer(title, 'pointerdown', {});
  pointer(window, 'pointermove', { clientY: 100 });
  expect(drawer.style.translate).toBe('');
  pointer(window, 'pointercancel', {});
  pointer(title, 'pointerdown', {});
  pointer(window, 'pointermove', { clientX: -100 });
  expect(drawer.style.translate).toBe('-100px 0px');
  pointer(window, 'pointerup', { clientX: -100 });
  expect(onChange).toHaveBeenCalledWith(false);
});
