'use client';

import { useEffect } from 'react';

/**
 * Page scroll lock of the modal layers (design-system §5.5, HOMEDLG-01-AC03) that leaves the page's
 * layout alone. Radix's RemoveScroll hides the page's overflow, which takes the scrollbar away:
 * the content shifted sideways by the scrollbar's width (its body margin compensation) or, with
 * a `scrollbar-gutter: stable` root, the root's `clientWidth` still changed in Chromium. The kit
 * turns that part off (overlays.css) and keeps the scrollbar: RemoveScroll still cancels wheel and
 * touch scrolling outside the layer, and this freeze puts the page back wherever anything else
 * (keyboard scrolling, dragging the scrollbar, a focus() that scrolls) moves it while a modal
 * layer is open. Several open modal layers share one freeze.
 */
let holders = 0;
let frozen: { x: number; y: number } | null = null;

function restore() {
  if (!frozen) return;
  if (window.scrollX !== frozen.x || window.scrollY !== frozen.y) {
    window.scrollTo({ left: frozen.x, top: frozen.y, behavior: 'instant' });
  }
}

function hold(): () => void {
  holders += 1;
  if (holders === 1) {
    frozen = { x: window.scrollX, y: window.scrollY };
    window.addEventListener('scroll', restore, { passive: true });
  }
  return () => {
    holders -= 1;
    if (holders === 0) {
      window.removeEventListener('scroll', restore);
      frozen = null;
    }
  };
}

/** Keeps the page's scroll position while `active` (an open modal layer). */
export function useScrollFreeze(active: boolean): void {
  useEffect(() => (active ? hold() : undefined), [active]);
}
