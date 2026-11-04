'use client';

import { useRef, type MouseEvent, type PointerEvent } from 'react';

/**
 * Backdrop click of a modal panel or dialog (design-system §5.5, HOMEDLG-01): a click (or tap) that
 * both starts and ends on the backdrop closes the dialog, like Escape — unless `closable` is false
 * (the dialog holds unsaved input, or never closes from its backdrop). Either way the click is
 * consumed by the backdrop, never passed to the content underneath.
 *
 * Radix dismisses on `pointerdown` outside; the dialogs cancel that (see `onPointerDownOutside`)
 * and close on the backdrop's `click` instead: closing on pointerdown removed the backdrop before
 * the button went up, so the rest of the click could land on whatever was under it (a heatmap
 * marker opening its question).
 */
export function useBackdropClose(closable: boolean, close: () => void) {
  const pressed = useRef(false);
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      pressed.current = event.target === event.currentTarget;
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      const fromBackdrop = pressed.current && event.target === event.currentTarget;
      pressed.current = false;
      event.preventDefault();
      event.stopPropagation();
      if (fromBackdrop && closable) close();
    },
  };
}
