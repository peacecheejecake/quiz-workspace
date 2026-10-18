'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { tabbables } from './tabbable';

/**
 * Independently scrolling overlay body (FloatingSidePanel, ModalDialog). While its content
 * overflows and holds nothing focusable (e.g. a long excerpt), keyboard users could not reach
 * it to scroll (WCAG 2.1.1, axe `scrollable-region-focusable`): it then becomes a tab stop,
 * named after the enclosing dialog's title. Otherwise it stays a plain, unfocusable container.
 */
export function ScrollRegion({ className, children }: { className: string; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [labelledBy, setLabelledBy] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const scrollable = el.scrollHeight > el.clientHeight + 1;
      const needsFocus = scrollable && tabbables(el).length === 0;
      // '' marks "focusable without a known title" so state still flips.
      setLabelledBy(
        needsFocus ? (el.closest('[role="dialog"]')?.getAttribute('aria-labelledby') ?? '') : null,
      );
    };
    update();
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    resize?.observe(el);
    const observeChildren = () => {
      for (const child of Array.from(el.children)) resize?.observe(child);
    };
    observeChildren();
    const mutation = new MutationObserver(() => {
      observeChildren();
      update();
    });
    mutation.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['disabled', 'tabindex', 'hidden', 'href', 'contenteditable'],
    });
    return () => {
      resize?.disconnect();
      mutation.disconnect();
    };
  }, []);

  const focusable = labelledBy !== null;
  return (
    <div
      ref={ref}
      className={className}
      data-scroll-focus={focusable || undefined}
      {...(focusable
        ? { tabIndex: 0, role: 'group', 'aria-labelledby': labelledBy || undefined }
        : {})}
    >
      {children}
    </div>
  );
}
