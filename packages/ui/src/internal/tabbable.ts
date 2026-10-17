import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** Tabbable elements in document order (positive tabindex ordering is not supported). */
export function tabbables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.closest('[hidden], [inert]'),
  );
}

/**
 * Non-modal Tab handoff: Radix dialog content always loops focus at its edges, which would
 * keep keyboard users inside a non-modal panel. When Tab leaves the panel's last tabbable
 * element (or Shift+Tab leaves the first), move focus back into the page next to `anchor`
 * (the element that opened the panel) instead. Returns true when it moved focus.
 */
export function handOffFocus(
  event: KeyboardEvent | ReactKeyboardEvent,
  panel: HTMLElement,
  anchor: HTMLElement | null,
): boolean {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return false;
  const inside = tabbables(panel);
  const active = document.activeElement;
  const atEdge = event.shiftKey
    ? active === inside[0] || active === panel
    : active === inside.at(-1);
  if (!atEdge || (!event.shiftKey && inside.length === 0)) return false;

  const outside = tabbables(document).filter((el) => !panel.contains(el));
  if (outside.length === 0) return false;
  const anchorIndex = anchor?.isConnected ? outside.indexOf(anchor) : -1;
  let target: HTMLElement | undefined;
  if (event.shiftKey) {
    target = anchorIndex >= 0 ? outside[anchorIndex] : outside.at(-1);
  } else {
    target = anchorIndex >= 0 ? outside[anchorIndex + 1] : outside[0];
    target ??= outside[0];
  }
  if (!target) return false;
  event.preventDefault();
  target.focus();
  return true;
}
