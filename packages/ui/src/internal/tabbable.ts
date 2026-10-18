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

/** Whether the element is rendered (not display:none / visibility:hidden, not hidden/inert). */
export function isRendered(el: HTMLElement): boolean {
  if (el.closest('[hidden], [inert]')) return false;
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
  }
  // Fallback (older engines, jsdom): walk the ancestors' computed styles.
  const view = el.ownerDocument.defaultView;
  if (!view) return true;
  if (view.getComputedStyle(el).visibility === 'hidden') return false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (view.getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

/** Rendered tabbable elements in document order (positive tabindex ordering is not supported). */
export function tabbables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.tabIndex >= 0 && isRendered(el),
  );
}

/** Focuses the first candidate that actually takes focus; returns it, or null. */
function focusFirst(candidates: Iterable<HTMLElement>): HTMLElement | null {
  for (const el of candidates) {
    el.focus();
    if (el.ownerDocument.activeElement === el) return el;
  }
  return null;
}

function follows(a: Node, b: Node): boolean {
  return Boolean(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/**
 * Non-modal Tab handoff: Radix dialog content always loops focus at its edges, which would
 * keep keyboard users inside a non-modal panel. When Tab leaves the panel's last tabbable
 * element (or Shift+Tab leaves the first), move focus back into the page next to `anchor`
 * (the element that opened the panel) instead. Hidden or unfocusable candidates are skipped;
 * if nothing outside takes focus, the default (looping) behaviour is kept. Returns true when it
 * moved focus.
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
  const anchorNode = anchor?.isConnected ? anchor : null;

  let ordered: HTMLElement[];
  if (event.shiftKey) {
    // Back to the opener if it can take focus, else the closest candidate before it.
    const before = anchorNode
      ? outside.filter((el) => el === anchorNode || follows(anchorNode, el))
      : [];
    const after = outside.filter((el) => !before.includes(el));
    ordered = [...before.reverse(), ...after.reverse()];
  } else {
    // The first candidate after the opener, wrapping around to the top of the page.
    const after = anchorNode ? outside.filter((el) => follows(el, anchorNode)) : outside;
    ordered = [...after, ...outside.filter((el) => !after.includes(el))];
  }

  const focused = focusFirst(ordered);
  if (!focused) return false;
  event.preventDefault();
  return true;
}
