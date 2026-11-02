'use client';

/**
 * The control a panel was opened from, when focus does not tell: Safari (WebKit) does not focus a
 * button on a mouse click, so `document.activeElement` is not the opener when the panel opens and
 * focus could not return to it on close (HOMEDLG-01-AC01). The panel then takes the control
 * clicked just before it opened.
 */
const RECENT_MS = 1500;
const CONTROL = 'button, a[href], [role="button"], [role="menuitem"], [tabindex]';

let last: { readonly element: HTMLElement; readonly at: number } | null = null;
let listening = false;

function remember(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target.closest(CONTROL) : null;
  if (target instanceof HTMLElement) last = { element: target, at: performance.now() };
}

/** Starts watching clicks (once per document; call it before the panels can open). */
export function watchOpeners(): void {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener('click', remember, true);
}

/**
 * The element focused now — unless a control was clicked just now inside it (or nothing is
 * focused): Safari leaves focus on `<body>` or moves it to the clicked button's focusable ancestor
 * (e.g. a `tabindex="-1"` `<main>`), and the clicked control is the opener then.
 */
export function currentOpener(): HTMLElement | null {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const clicked =
    last && performance.now() - last.at <= RECENT_MS && last.element.isConnected
      ? last.element
      : null;
  if (clicked && (!active || active === document.body || active.contains(clicked))) return clicked;
  return active === document.body ? null : active;
}
