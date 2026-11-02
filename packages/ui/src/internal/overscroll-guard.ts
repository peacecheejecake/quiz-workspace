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
 * element on the way can still scroll in the gesture's direction the event is left alone (the
 * surface scrolls natively, with momentum), otherwise it is cancelled. Pinch-zoom (two touches),
 * ctrl+wheel zoom, range sliders and events the browser already made uncancelable are untouched.
 */
export function containOverscroll(root: HTMLElement): () => void {
  let last: { x: number; y: number } | null = null;

  const baseline = (event: TouchEvent) => {
    const touch = event.touches[0];
    last = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
  };

  const guard = (event: Event, dx: number, dy: number) => {
    if (dx === 0 && dy === 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input[type="range"]')) return;
    const axis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x';
    if (!scrollsWithin(target, root, axis, axis === 'y' ? dy : dx)) event.preventDefault();
  };

  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (event.touches.length !== 1 || !touch) {
      last = null;
      return;
    }
    const from = last;
    last = { x: touch.clientX, y: touch.clientY };
    if (!from || !event.cancelable) return;
    // Content moves opposite to the finger: a finger moving up (negative) scrolls down.
    guard(event, from.x - touch.clientX, from.y - touch.clientY);
  };

  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || !event.cancelable) return;
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

const SCROLLS = /^(auto|scroll|overlay)$/;

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
