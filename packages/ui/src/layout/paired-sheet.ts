'use client';

import { mediaQueries } from '@quiz/design-tokens';
import { useSyncExternalStore } from 'react';

/**
 * Whether a paired dialog (`FloatingSidePanel paired`) is a full-screen sheet at this viewport
 * width: narrower than the question panel plus the dialog's minimum width and margins
 * (`--breakpoint-paired-panel`, 868px; design-system §5.6). Below the mobile breakpoint every
 * panel is a sheet anyway, so this is also true there. Server render and first paint report false.
 * The caller owns the sheet's Back behaviour (a history entry while a sheet is open, QSRC-01-AC04).
 */
export function usePairedSheet(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(mediaQueries.pairedSheet);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function snapshot(): boolean {
  return (
    typeof window.matchMedia === 'function' && window.matchMedia(mediaQueries.pairedSheet).matches
  );
}
