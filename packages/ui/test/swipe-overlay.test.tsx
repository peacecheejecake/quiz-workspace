import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ModalDialog } from '../src';

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
  it('UX10-UI-AC03 closes from an empty header in the nearest direction', () => {
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
