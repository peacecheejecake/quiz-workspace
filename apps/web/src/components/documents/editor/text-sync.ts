// DOC-02-AC08 (DOCVIEW): scrolls the text pane to what a PDF page shows (lib/documents/text-groups
// textTargetForPage): the page's group (its sticky heading on top), or the block that continues
// onto the page. DOCVIEW-01: a pane shown again by a view mode catches up (useWhenShown).
import { useEffect, useRef } from 'react';
import type { TextTarget } from '@/lib/documents/text-groups';

/** The element of a block in the text pane: its own article, or the card that contains it. */
export function blockElement(scroller: HTMLElement, blockId: string): HTMLElement | null {
  const id = CSS.escape(blockId);
  return (
    scroller.querySelector<HTMLElement>(`[data-block-id="${id}"]`) ??
    scroller.querySelector<HTMLElement>(`[data-block-ids~="${id}"]`)
  );
}

/** Puts `target` at the top of the scroller (instant; nothing when it is not rendered). */
export function scrollTextTo(scroller: HTMLElement | null, target: TextTarget | null): void {
  if (!scroller) return;
  if (target === null) {
    scroller.scrollTop = 0;
    return;
  }
  const element =
    target.kind === 'page'
      ? scroller.querySelector<HTMLElement>(`[data-page-group="${target.page}"]`)
      : blockElement(scroller, target.blockId);
  if (!element) return;
  const offset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop = Math.max(scroller.scrollTop + offset - 8, 0);
}

/**
 * Calls `onShown` (the latest one) right after `visible` turns from false to true: a pane hidden by
 * a DOCVIEW-01 view mode could not scroll while hidden, so it catches up when it shows again.
 */
export function useWhenShown(visible: boolean, onShown: () => void): void {
  const latest = useRef(onShown);
  const wasVisible = useRef(visible);
  useEffect(() => {
    latest.current = onShown;
  }, [onShown]);
  useEffect(() => {
    if (visible && !wasVisible.current) latest.current();
    wasVisible.current = visible;
  }, [visible]);
}
