'use client';

// HOMEDLG-01: the home's dialogs are modal and stack in the order they were opened, the top one
// active (design-system §5.5). A deep link can list several (`?panel=documents&panel=mock-exams`):
// they must still open one after another, each in its own commit, because every modal layer
// takes its place when it mounts — Radix hides the rest of the page from assistive technology,
// traps focus and ranks Escape by mount order. Opened in one commit, the first dialog would hide
// the second one (the top) and the stacking would follow the render order, not the URL's.
import { useEffect, useLayoutEffect, useState } from 'react';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * The dialogs of `wanted` (ids in opening order) that are shown: a newly wanted one is added in a
 * commit of its own after the ones before it; one no longer wanted leaves at once.
 */
export function useStagedDialogs(wanted: readonly string[]): ReadonlySet<string> {
  const [shown, setShown] = useState<readonly string[]>([]);
  const kept = shown.filter((dialog) => wanted.includes(dialog));
  if (kept.length !== shown.length) setShown(kept);
  const next = wanted.find((dialog) => !kept.includes(dialog));
  useIsomorphicLayoutEffect(() => {
    if (next === undefined) return;
    setShown((prev) => (prev.includes(next) ? prev : [...prev, next]));
  }, [next]);
  return new Set(kept);
}
