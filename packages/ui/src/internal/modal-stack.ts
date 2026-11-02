'use client';

import { useEffect, useRef } from 'react';

/**
 * The open modal layers in opening order (the last one on top). Escape always closes the top
 * dialog first (user decision 2026-11-02, HOMEDLG-01): a toast is a dismissable layer of its own
 * and, shown over a modal, would take the Escape otherwise — it hands the key to the top modal
 * instead and closes only by its own button or timeout (Toast.tsx).
 */
const stack: { readonly close: () => void }[] = [];

/** Registers a modal layer while `open`; `close` closes it as Escape would. */
export function useModalStackEntry(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return undefined;
    const entry = { close: () => closeRef.current() };
    stack.push(entry);
    return () => {
      const at = stack.indexOf(entry);
      if (at !== -1) stack.splice(at, 1);
    };
  }, [open]);
}

/** Closes the top modal layer; false when none is open. */
export function closeTopModal(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}
