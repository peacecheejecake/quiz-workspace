// @vitest-environment jsdom
import './dom-setup';
import { render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyboardMetrics, useKeyboardInset } from '../src/components/app-shell/use-keyboard-inset';

const LAYOUT_HEIGHT = 800;

class MockViewport extends EventTarget {
  height = LAYOUT_HEIGHT;
  offsetTop = 0;
  scale = 1;

  move(state: Partial<Pick<MockViewport, 'height' | 'offsetTop' | 'scale'>>, event = 'resize') {
    Object.assign(this, state);
    act(() => void this.dispatchEvent(new Event(event)));
  }
}

function Harness() {
  useKeyboardInset();
  return null;
}

const css = (name: string) => document.documentElement.style.getPropertyValue(name);

describe('keyboardMetrics', () => {
  const metrics = (height: number, offsetTop: number, scale = 1) =>
    keyboardMetrics({ height, offsetTop, scale }, LAYOUT_HEIGHT);

  it('reports nothing while the visual viewport fills the layout viewport', () => {
    expect(metrics(LAYOUT_HEIGHT, 0)).toEqual({ inset: 0, offsetTop: 0 });
  });

  it('splits the covered height into what is hidden below and what was panned off the top', () => {
    expect(metrics(500, 120)).toEqual({ inset: 180, offsetTop: 120 });
    expect(metrics(500, 300)).toEqual({ inset: 0, offsetTop: 300 });
  });

  it('never reports a negative value from a sub-pixel or rubber-band reading', () => {
    expect(metrics(500, 300.6)).toEqual({ inset: 0, offsetTop: 301 });
    expect(metrics(500, -20)).toEqual({ inset: 300, offsetTop: 0 });
  });

  it('ignores pinch-zoom: a magnified visual viewport is not a keyboard', () => {
    expect(metrics(400, 200, 2)).toEqual({ inset: 0, offsetTop: 0 });
  });

  it('ignores a classic horizontal scrollbar', () => {
    expect(metrics(LAYOUT_HEIGHT - 15, 0)).toEqual({ inset: 0, offsetTop: 0 });
  });
});

describe('useKeyboardInset', () => {
  let viewport: MockViewport;

  beforeEach(() => {
    viewport = new MockViewport();
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', LAYOUT_HEIGHT);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('style');
  });

  it('follows the visual viewport on resize and scroll', () => {
    render(<Harness />);
    viewport.move({ height: 500 });
    expect(css('--qz-keyboard-inset')).toBe('300px');
    expect(css('--qz-keyboard-offset-top')).toBe('0px');

    viewport.move({ offsetTop: 200 }, 'scroll');
    expect(css('--qz-keyboard-inset')).toBe('100px');
    expect(css('--qz-keyboard-offset-top')).toBe('200px');
  });

  it('goes back to zero when the keyboard closes', () => {
    render(<Harness />);
    viewport.move({ height: 500, offsetTop: 200 });
    viewport.move({ height: LAYOUT_HEIGHT, offsetTop: 0 });
    expect(css('--qz-keyboard-inset')).toBe('0px');
    expect(css('--qz-keyboard-offset-top')).toBe('0px');
  });

  it('adds nothing when resizes-content shrinks the layout viewport with the visual one', () => {
    render(<Harness />);
    vi.stubGlobal('innerHeight', 500);
    viewport.move({ height: 500 });
    expect(css('--qz-keyboard-inset')).toBe('0px');
  });

  it('removes its values and listeners on unmount', () => {
    const { unmount } = render(<Harness />);
    viewport.move({ height: 500 });
    unmount();
    expect(css('--qz-keyboard-inset')).toBe('');
    viewport.move({ height: 400 });
    expect(css('--qz-keyboard-inset')).toBe('');
  });

  it('does nothing without visualViewport', () => {
    vi.stubGlobal('visualViewport', undefined);
    render(<Harness />);
    expect(css('--qz-keyboard-inset')).toBe('');
  });
});
