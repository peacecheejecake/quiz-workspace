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
//
// A layer opened above the modal layers (`aboveModals`, e.g. ASK-01's AI 질문 panel opened from
// the 문제 상세 dialog) and every layer opened after it while it is open (its 본문 발췌 panel) sit
// above `--z-modal` instead, in the same order, below `--z-toast`.

const order: string[] = [];
const elevated = new Set<string>();
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

function bringToFront(id: string, aboveModals: boolean) {
  const wasElevated = elevated.has(id);
  if (aboveModals) elevated.add(id);
  else elevated.delete(id);
  const at = order.indexOf(id);
  if (at === order.length - 1 && at !== -1) {
    if (wasElevated !== aboveModals) emit();
    return;
  }
  if (at !== -1) order.splice(at, 1);
  order.push(id);
  emit();
}

function release(id: string) {
  elevated.delete(id);
  const at = order.indexOf(id);
  if (at === -1) return;
  order.splice(at, 1);
  emit();
}

/** Whether the layer at `rank` is above the modal layers (it or a layer below it asked to be). */
function isAboveModals(rank: number): boolean {
  for (let i = 0; i <= rank; i += 1) {
    if (elevated.has(order[i] ?? '')) return true;
  }
  return false;
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
export function useFloatingLayer(
  open: boolean,
  raiseKey?: unknown,
  aboveModals = false,
): FloatingLayer {
  const id = useId();
  // A new `raiseKey` while open re-registers the layer, which puts it on top again.
  useIsomorphicLayoutEffect(() => {
    if (!open) return undefined;
    bringToFront(id, aboveModals);
    return () => release(id);
  }, [id, open, raiseKey, aboveModals]);
  const rank = useSyncExternalStore(
    subscribe,
    () => order.indexOf(id),
    () => -1,
  );
  const above = useSyncExternalStore(
    subscribe,
    () => isAboveModals(order.indexOf(id)),
    () => false,
  );
  const step = Math.max(rank, 0) * 2;
  return {
    rank,
    zIndex: above
      ? `min(calc(var(--z-modal) + 2 + ${step}), calc(var(--z-toast) - 2))`
      : `min(calc(var(--z-side-panel) + ${step}), calc(var(--z-modal) - 2))`,
  };
}
