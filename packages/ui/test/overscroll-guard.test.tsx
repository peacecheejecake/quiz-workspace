import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FloatingSidePanel, ModalDialog, Popover, PopoverContent, PopoverTrigger } from '../src';
import { containOverscroll } from '../src/internal/overscroll-guard';

// UX9-SCROLL: touch swipes / wheel turns on an overlay never chain to the page underneath.
// jsdom has no layout or Touch constructor: scroll sizes are stubbed per element and the touch
// points are plain objects on the event's touch lists (as in the E2E spec).

function sized(el: HTMLElement, { height, content, top = 0 }: Record<string, number>) {
  el.style.overflowY = 'auto';
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: height });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: content });
  el.scrollTop = top;
}

function touch(target: EventTarget, type: string, y: number, fingers = 1): TouchEvent {
  const event = new TouchEvent(type, { bubbles: true, cancelable: true });
  const point = { identifier: 1, target, clientX: 10, clientY: y };
  const active = type === 'touchend' ? [] : Array.from({ length: fingers }, () => point);
  Object.defineProperty(event, 'touches', { value: active });
  Object.defineProperty(event, 'changedTouches', { value: [point] });
  target.dispatchEvent(event);
  return event;
}

/** Swipes on `target` (finger travel `dy`); returns whether the touchmove was cancelled. */
function swipe(target: Element, dy: number, fingers = 1): boolean {
  touch(target, 'touchstart', 300, fingers);
  const move = touch(target, 'touchmove', 300 + dy, fingers);
  touch(target, 'touchend', 300 + dy);
  return move.defaultPrevented;
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function wheel(target: EventTarget, deltaY: number, init: WheelEventInit = {}): boolean {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('containOverscroll', () => {
  let release: (() => void) | undefined;
  afterEach(() => {
    release?.();
    release = undefined;
    document.body.innerHTML = '';
  });

  function surface() {
    document.body.innerHTML = `
      <div id="root"><div id="header">title</div><div id="body"><p id="text">text</p></div>
        <input id="range" type="range" /></div>`;
    const root = byId('root');
    const body = byId('body');
    release = containOverscroll(root);
    return {
      root,
      body,
      header: byId('header'),
      text: byId('text'),
    };
  }

  it('cancels swipes on a part that does not scroll (header), both directions', () => {
    const { header } = surface();
    expect(swipe(header, -80)).toBe(true);
    expect(swipe(header, 80)).toBe(true);
  });

  it('lets the body scroll inside, and cancels at its ends in the direction past the end', () => {
    const { body, text } = surface();
    sized(body, { height: 100, content: 500, top: 200 });
    expect(swipe(text, -80)).toBe(false);
    expect(swipe(text, 80)).toBe(false);

    body.scrollTop = 400; // bottom
    expect(swipe(text, -80)).toBe(true);
    expect(swipe(text, 80)).toBe(false);

    body.scrollTop = 0; // top
    expect(swipe(text, 80)).toBe(true);
    expect(swipe(text, -80)).toBe(false);
  });

  it('treats a body without overflow as not scrollable', () => {
    const { body, text } = surface();
    sized(body, { height: 100, content: 100 });
    expect(swipe(text, -80)).toBe(true);
  });

  it('applies the same rule to the wheel, but leaves ctrl+wheel (zoom) alone', () => {
    const { body, header, text } = surface();
    sized(body, { height: 100, content: 500, top: 200 });
    expect(wheel(header, 100)).toBe(true);
    expect(wheel(text, 100)).toBe(false);
    body.scrollTop = 400;
    expect(wheel(text, 100)).toBe(true);
    expect(wheel(header, 100, { ctrlKey: true })).toBe(false);
  });

  it('leaves pinch-zoom and range sliders native', () => {
    const { header } = surface();
    expect(swipe(header, -80, 2)).toBe(false);
    expect(swipe(byId('range'), -80)).toBe(false);
  });

  it('hides what it leaves to the browser from document listeners, not what it cancels', () => {
    const { body, header, text } = surface();
    sized(body, { height: 100, content: 500, top: 200 });
    const seen: EventTarget[] = [];
    const listener = (event: Event) => {
      if (event.target) seen.push(event.target);
    };
    document.addEventListener('wheel', listener);
    document.addEventListener('touchmove', listener);
    wheel(text, 100);
    swipe(text, -80);
    expect(seen).toEqual([]);
    wheel(header, 100);
    swipe(header, -80);
    expect(seen).toEqual([header, header]);
    document.removeEventListener('wheel', listener);
    document.removeEventListener('touchmove', listener);
  });

  it('decides nothing within the touch slop, then judges the distance from the touch', () => {
    const { header } = surface();
    touch(header, 'touchstart', 300);
    expect(touch(header, 'touchmove', 301.5).defaultPrevented).toBe(false);
    expect(touch(header, 'touchmove', 303).defaultPrevented).toBe(false);
    expect(touch(header, 'touchmove', 305).defaultPrevented).toBe(true);
    touch(header, 'touchend', 305);
  });

  it('reads a gesture reported on a text node from its element', () => {
    const { body, text } = surface();
    sized(body, { height: 100, content: 500, top: 0 });
    expect(wheel(text.firstChild as Text, 100)).toBe(false);
  });

  it('stops guarding once released, and never touches events outside the surface', () => {
    const { header } = surface();
    const outside = document.createElement('div');
    document.body.append(outside);
    expect(swipe(outside, -80)).toBe(false);
    release?.();
    release = undefined;
    expect(swipe(header, -80)).toBe(false);
  });
});

describe('overlay components guard their surface', () => {
  it.each([
    [
      '문서 관리',
      <FloatingSidePanel key="p" open modal={false} title="문서 관리">
        본문
      </FloatingSidePanel>,
    ],
    [
      '문제',
      <FloatingSidePanel key="m" open title="문제">
        본문
      </FloatingSidePanel>,
    ],
    [
      'workspace 만들기',
      <ModalDialog key="d" open title="workspace 만들기">
        폼
      </ModalDialog>,
    ],
    [
      '설정',
      <Popover key="o" open>
        <PopoverTrigger>열기</PopoverTrigger>
        <PopoverContent aria-label="설정">설정 내용</PopoverContent>
      </Popover>,
    ],
  ])('%s cancels a swipe on its non-scrolling surface', async (name, overlay) => {
    render(overlay);
    const dialog = await screen.findByRole('dialog', { name });
    expect(swipe(dialog, -80)).toBe(true);
  });

  it('a docked FloatingSidePanel is part of the page layout and is not guarded', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    render(
      <FloatingSidePanel open placement="docked" container={host} title="목차">
        목차 항목
      </FloatingSidePanel>,
    );
    const panel = await screen.findByRole('dialog', { name: '목차' });
    expect(swipe(panel, -80)).toBe(false);
    host.remove();
  });
});
