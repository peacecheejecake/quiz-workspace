// DOC-02-AC08 (DOCVIEW): scrolls the text pane to what a PDF page shows (lib/documents/text-groups
// textTargetForPage): the page's group (its sticky heading on top), or the block that continues
// onto the page.
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
