'use client';

import { createContext, useContext, type CSSProperties } from 'react';

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
