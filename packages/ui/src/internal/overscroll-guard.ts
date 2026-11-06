'use client';

import { useCallback } from 'react';

/**
 * Overscroll guard for floating surfaces (UX9-SCROLL): a touch swipe or wheel turn that starts on
 * an overlay never scrolls the page underneath it.
 *
 * Without it, a gesture whose target cannot scroll in that direction chains to the next scroll
 * container, which for a floating surface is the page: swiping a dialog header, or a dialog body
 * that is already at its end, moved the page behind it (iOS Safari). `overscroll-behavior:
 * contain` alone does not help there: it only applies once the target itself is a scroller that
 * scrolled, and iOS ignores `overflow: hidden` on the body. Radix's modal scroll lock
 * (react-remove-scroll) already does this for modal layers; non-modal layers (문서 관리, 모의고사,
 * excerpt panels, popovers) had no guard at all, and the page outside them must stay scrollable,
 * so the guard listens on the surface itself rather than on the document.
 *
 * On every touchmove/wheel inside `root` it walks from the event target up to `root`: when some
 * element on the way can still scroll in the gesture's direction the event is left to the browser
 * (the surface scrolls natively, with momentum), otherwise it is cancelled. Pinch-zoom (two
 * touches), ctrl+wheel zoom, range sliders and events the browser already made uncancelable are
 * untouched.
 *
 * The surface owns its gestures (UX12-CHAPTERSCROLL): an event it leaves to the browser also stops
 * here, before react-remove-scroll's document listeners. Those cancel for the top lock anything
 * that is not inside that lock, which is every popover portalled out of a modal panel, and they
 * cancel a touchmove whose distance from the touch start is 0 or points past the end, which is the
 * finger's first jitter on a list at its top. iOS decides on the first touchmove: one cancelled
 * move ends the scroll of the whole gesture. So moves within `TOUCH_SLOP` decide nothing.
 */
export function containOverscroll(root: HTMLElement): () => void {
  let last: { x: number; y: number } | null = null;

  const baseline = (event: TouchEvent) => {
    const touch = event.touches[0];
    last = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
  };

  const guard = (event: Event, dx: number, dy: number) => {
    const target = elementOf(event.target);
    if (target?.closest('input[type="range"]')) return;
    const axis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x';
    if (scrollsWithin(target, root, axis, axis === 'y' ? dy : dx)) event.stopPropagation();
    else event.preventDefault();
  };

  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (event.touches.length !== 1 || !touch) {
      last = null;
      return;
    }
    const from = last;
    const at = { x: touch.clientX, y: touch.clientY };
    if (!from || !event.cancelable) {
      last = at;
      return;
    }
    // Content moves opposite to the finger: a finger moving up (negative) scrolls down.
    const dx = from.x - at.x;
    const dy = from.y - at.y;
    if (Math.hypot(dx, dy) < TOUCH_SLOP) {
      event.stopPropagation();
      return;
    }
    last = at;
    guard(event, dx, dy);
  };

  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || !event.cancelable) return;
    if (event.deltaX === 0 && event.deltaY === 0) return;
    guard(event, event.deltaX, event.deltaY);
  };

  const active: AddEventListenerOptions = { passive: false };
  root.addEventListener('touchstart', baseline, { passive: true });
  root.addEventListener('touchend', baseline, { passive: true });
  root.addEventListener('touchcancel', baseline, { passive: true });
  root.addEventListener('touchmove', onTouchMove, active);
  root.addEventListener('wheel', onWheel, active);
  return () => {
    root.removeEventListener('touchstart', baseline);
    root.removeEventListener('touchend', baseline);
    root.removeEventListener('touchcancel', baseline);
    root.removeEventListener('touchmove', onTouchMove);
    root.removeEventListener('wheel', onWheel);
  };
}

/** Callback ref that guards the referenced surface while it is mounted (`containOverscroll`). */
export function useOverscrollGuard<T extends HTMLElement>() {
  return useCallback((el: T | null) => (el ? containOverscroll(el) : undefined), []);
}

/** Finger travel (px) that says nothing yet about a swipe's direction. Below any browser's pan. */
const TOUCH_SLOP = 4;

const SCROLLS = /^(auto|scroll|overlay)$/;

/** The element under the gesture: an engine may report the text node itself. */
function elementOf(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

/** Whether `target` or an ancestor up to and including `root` can scroll by `delta` on `axis`. */
function scrollsWithin(
  target: Element | null,
  root: HTMLElement,
  axis: 'x' | 'y',
  delta: number,
): boolean {
  for (let el = target; el; el = el.parentElement) {
    if (canScroll(el, axis, delta)) return true;
    if (el === root) return false;
  }
  return false;
}

function canScroll(el: Element, axis: 'x' | 'y', delta: number): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  if (!SCROLLS.test(axis === 'y' ? style.overflowY : style.overflowX)) return false;
  if (axis === 'y') {
    const max = el.scrollHeight - el.clientHeight;
    return max >= 1 && (delta > 0 ? el.scrollTop < max - 1 : el.scrollTop > 0);
  }
  const max = el.scrollWidth - el.clientWidth;
  if (max < 1) return false;
  // RTL scrollers count scrollLeft from 0 down to -max.
  const rtl = style.direction === 'rtl';
  const position = rtl ? -el.scrollLeft : el.scrollLeft;
  const forward = rtl ? delta < 0 : delta > 0;
  return forward ? position < max - 1 : position > 0;
}
