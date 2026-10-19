'use client';

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';

/**
 * z-index expression of the floating layer (side panel, modal) that currently contains the
 * component. Popovers and tooltips opened from inside a panel portal to `<body>`, so without
 * this they would sit at `--z-popover` (20), underneath the panel (40) or modal (60).
 */
const LayerContext = createContext<string | null>(null);

export const LayerProvider = LayerContext.Provider;

/** Inline style that lifts a portalled popper above its containing layer, if any. */
export function useLayerStyle(): CSSProperties | undefined {
  const layer = useContext(LayerContext);
  return layer ? { zIndex: `calc(${layer} + 1)` } : undefined;
}

// --- Stacking of floating (non-centered-modal) layers --------------------------------------------
//
// Several floating panels/dialogs can be open at once. Portal DOM order is not a reliable stacking
// order (a panel mounted earlier in the tree can portal later), so every open floating layer takes
// a rank by the time it opened: the most recently opened one is on top, and re-opening an earlier
// one moves it to the top. Rank r sits at `--z-side-panel + 2r` (its popovers at +1, see
// useLayerStyle) and is capped below `--z-modal`, so centered modal dialogs stay above all panels.

const order: string[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function bringToFront(id: string) {
  const at = order.indexOf(id);
  if (at === order.length - 1 && at !== -1) return;
  if (at !== -1) order.splice(at, 1);
  order.push(id);
  emit();
}

function release(id: string) {
  const at = order.indexOf(id);
  if (at === -1) return;
  order.splice(at, 1);
  emit();
}

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface FloatingLayer {
  /** Position among the open floating layers (0 = bottom), or -1 while closed. */
  rank: number;
  /** z-index expression for the layer's content (and its backdrop). */
  zIndex: string;
}

/**
 * Registers a floating layer while `open` and returns its stacking z-index. Use it for every
 * floating surface that can coexist with others (FloatingSidePanel today; floating dialogs that
 * are not side panels should reuse it), and pass `zIndex` to `LayerProvider` so the layer's
 * portalled popovers and tooltips sit just above it.
 */
export function useFloatingLayer(open: boolean): FloatingLayer {
  const id = useId();
  useIsomorphicLayoutEffect(() => {
    if (!open) return undefined;
    bringToFront(id);
    return () => release(id);
  }, [id, open]);
  const rank = useSyncExternalStore(
    subscribe,
    () => order.indexOf(id),
    () => -1,
  );
  const step = Math.max(rank, 0) * 2;
  return {
    rank,
    zIndex: `min(calc(var(--z-side-panel) + ${step}), calc(var(--z-modal) - 2))`,
  };
}
