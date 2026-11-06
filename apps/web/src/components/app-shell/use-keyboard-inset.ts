'use client';

// iOS Safari ignores `interactive-widget=resizes-content`: the virtual keyboard covers the layout
// viewport and Safari pans the visual viewport to show the focused field, taking fixed and sticky
// surfaces with the layout viewport. This publishes how far off they are as two CSS variables
// (docs/screens/ux12-keyboard.md). Where the layout viewport shrinks with the keyboard both stay 0.
import { useEffect } from 'react';

const INSET = '--qz-keyboard-inset';
const OFFSET_TOP = '--qz-keyboard-offset-top';
/** Taller than a classic horizontal scrollbar, which also separates the two viewports. */
const MIN_COVERED_PX = 24;

export interface KeyboardMetrics {
  /** Height hidden between the visual viewport's bottom and the layout viewport's bottom. */
  readonly inset: number;
  /** How far the visual viewport's top has moved down from the layout viewport's top. */
  readonly offsetTop: number;
}

const NO_KEYBOARD: KeyboardMetrics = { inset: 0, offsetTop: 0 };

export function keyboardMetrics(
  viewport: Pick<VisualViewport, 'height' | 'offsetTop' | 'scale'>,
  layoutHeight: number,
): KeyboardMetrics {
  // A pinch-zoomed visual viewport is smaller too, and zooming must leave the page alone.
  if (Math.abs(viewport.scale - 1) > 0.01) return NO_KEYBOARD;
  if (layoutHeight - viewport.height < MIN_COVERED_PX) return NO_KEYBOARD;
  const offsetTop = Math.max(0, Math.round(viewport.offsetTop));
  const inset = Math.max(0, Math.round(layoutHeight - viewport.height - offsetTop));
  return { inset, offsetTop };
}

export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const apply = () => {
      const { inset, offsetTop } = keyboardMetrics(viewport, window.innerHeight);
      root.style.setProperty(INSET, `${inset}px`);
      root.style.setProperty(OFFSET_TOP, `${offsetTop}px`);
    };
    apply();
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    return () => {
      viewport.removeEventListener('resize', apply);
      viewport.removeEventListener('scroll', apply);
      root.style.removeProperty(INSET);
      root.style.removeProperty(OFFSET_TOP);
    };
  }, []);
}
