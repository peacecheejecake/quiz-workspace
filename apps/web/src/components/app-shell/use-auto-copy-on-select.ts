'use client';

// Drag auto-copy (UX12-SETTINGS-AC04..AC08). Mouse and pen selections only: touch gives no reliable
// end of selection and iOS wants a gesture for the clipboard. The selected text goes to the
// clipboard and nowhere else: never log it, send it or keep it.
import { copyableText, useToast } from '@quiz/ui';
import { useEffect, useSyncExternalStore } from 'react';
import { readAutoCopy, subscribeAutoCopy } from '@/lib/auto-copy-preference';
import { HIGHLIGHT_TEXT } from '@/lib/highlights/model';

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

interface SelectionEnds {
  readonly anchorNode: Node | null;
  readonly anchorOffset: number;
  readonly focusNode: Node | null;
  readonly focusOffset: number;
}

function endsOf(selection: Selection | null): SelectionEnds | null {
  if (!selection || selection.isCollapsed) return null;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  return { anchorNode, anchorOffset, focusNode, focusOffset };
}

function sameEnds(a: SelectionEnds | null, b: SelectionEnds | null): boolean {
  return (
    a?.anchorNode === b?.anchorNode &&
    a?.anchorOffset === b?.anchorOffset &&
    a?.focusNode === b?.focusNode &&
    a?.focusOffset === b?.focusOffset
  );
}

function inEditable(node: EventTarget | null): boolean {
  if (!(node instanceof Node)) return false;
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(EDITABLE) != null;
}

export function useAutoCopyEnabled(): boolean {
  return useSyncExternalStore(subscribeAutoCopy, readAutoCopy, () => false);
}

export function useAutoCopyOnSelect(): void {
  const enabled = useAutoCopyEnabled();
  const { toast, dismiss } = useToast();

  useEffect(() => {
    if (!enabled) return;
    let before: SelectionEnds | null | undefined;
    let timer: number | undefined;
    let shown: number | undefined;

    const copy = () => {
      const selection = window.getSelection();
      const ends = endsOf(selection);
      // Unchanged since the press: a click that left the selection alone, such as a menu item.
      if (!selection || !ends || sameEnds(ends, before ?? null)) return;
      if (inEditable(ends.anchorNode) || inEditable(ends.focusNode)) return;
      const text = copyableText(selection);
      if (text.trim() === '') return;
      const clipboard = navigator.clipboard as Clipboard | undefined;
      // A refused write stays quiet: an error on every drag would be worse than none.
      void clipboard?.writeText(text).then(
        () => {
          if (shown !== undefined) dismiss(shown);
          shown = toast({ title: HIGHLIGHT_TEXT.copied, tone: 'success' });
        },
        () => undefined,
      );
    };

    const onPointerDown = (event: PointerEvent) => {
      const eligible = event.button === 0 && event.pointerType !== 'touch';
      before = eligible && !inEditable(event.target) ? endsOf(window.getSelection()) : undefined;
    };
    const onPointerUp = () => {
      if (before === undefined) return;
      window.clearTimeout(timer);
      // The selection settles after the pointerup (double click, a click collapsing it).
      timer = window.setTimeout(copy, 0);
    };
    const onPointerCancel = () => {
      before = undefined;
    };

    // Capture: overlays stop these events from bubbling.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerCancel, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerCancel, true);
    };
  }, [enabled, toast, dismiss]);
}
