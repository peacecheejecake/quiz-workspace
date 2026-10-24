'use client';

import { useCallback } from 'react';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * Callback ref for an overlay surface (ModalDialog, ConfirmDialog, FloatingSidePanel) whose height
 * follows its content: when the content grows or shrinks (an alert appears, a loading state is
 * replaced), the surface glides from its previous height to the new one instead of jumping.
 *
 * CSS cannot transition `height: auto` → `auto`, so the hook does it FLIP-style: on every content
 * resize (ResizeObserver, before paint) it reads the CSS height with the inline height cleared,
 * pins the previous height inline, then sets the new one; `[data-resizing]` transitions it
 * (overlays.css). When it ends the inline height is removed, so CSS (max-height, fixed top/bottom
 * panels, mobile full-screen layout) stays in charge. Surfaces whose height does not depend on
 * their content (desktop side panels, full-screen mobile panels) measure the same height and
 * never animate. Nothing happens under `prefers-reduced-motion` or without ResizeObserver.
 */
export function useAnimatedHeight<T extends HTMLElement>() {
  return useCallback((el: T | null) => {
    if (!el || typeof ResizeObserver !== 'function') return;
    let settled: number | null = null;

    // Only `transitionend`: a transition cancelled by a newer content change is replaced by the
    // new one, which ends (and clears) on its own.
    const clear = (event: TransitionEvent) => {
      if (event.target !== el || event.propertyName !== 'height') return;
      el.style.height = '';
      el.removeAttribute('data-resizing');
    };

    const update = () => {
      if (!el.isConnected) return;
      const animating = el.style.height !== '';
      const from = animating ? el.offsetHeight : settled;
      el.style.height = '';
      // Layout height (not getBoundingClientRect): the open animation's scale must not count.
      const to = el.offsetHeight;
      settled = to;
      const reduced = typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION).matches;
      if (from === null || reduced || Math.abs(to - from) < 1) {
        el.removeAttribute('data-resizing');
        return;
      }
      el.setAttribute('data-resizing', '');
      el.style.height = `${from}px`;
      void el.offsetHeight; // commit the start height so the change below transitions
      el.style.height = `${to}px`;
    };

    const resize = new ResizeObserver(update);
    // The body is stretched by the surface (flex: 1), so its size follows the surface; observe
    // what is inside it and the other sections (header, footer) instead.
    const observeContent = () => {
      resize.disconnect();
      for (const child of Array.from(el.children)) {
        if (child.classList.contains('body')) {
          for (const inner of Array.from(child.children)) resize.observe(inner);
        } else {
          resize.observe(child);
        }
      }
    };
    observeContent();
    const body = el.querySelector(':scope > .body');
    // New sections or body children join the observer; text placed straight in the body (no
    // element to observe) is caught as character data.
    const mutation = new MutationObserver((records) => {
      if (records.some((r) => r.type === 'childList' && (r.target === el || r.target === body))) {
        observeContent();
      }
      update();
    });
    mutation.observe(el, { childList: true });
    if (body) mutation.observe(body, { childList: true, characterData: true, subtree: true });
    el.addEventListener('transitionend', clear);

    return () => {
      resize.disconnect();
      mutation.disconnect();
      el.removeEventListener('transitionend', clear);
    };
  }, []);
}
