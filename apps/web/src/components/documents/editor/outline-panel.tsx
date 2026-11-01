'use client';

// DOC-02-AC06 (DOCVIEW): the outline lives in a non-modal floating panel at the start (left) edge,
// toggled by the `목차` button in the PDF toolbar (Radix trigger: aria-expanded/aria-controls),
// its close button, or Escape while focus is inside. Open or closed is remembered in this browser;
// without a stored choice it starts open on desktop (≥1024px) and closed below. A panel opened
// from the stored choice on page load does not take focus.
import { Button, FloatingSidePanel, type FloatingSidePanelProps } from '@quiz/ui';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useMediaQuery, usePreference } from '@/lib/documents/viewer-preferences';
import styles from './editor.module.css';

export const OUTLINE_STORAGE_KEY = 'quiz:doc02:outline';
/** Wide enough to keep the panel beside the PDF instead of over it (editor.module.css). */
export const OUTLINE_BESIDE_QUERY = '(min-width: 1024px)';

export interface OutlinePanelState {
  /** null until hydrated (the server cannot know the stored choice or the width). */
  readonly open: boolean | null;
  /** The panel sits beside the content (desktop) instead of covering it; null before hydration. */
  readonly beside: boolean | null;
  /** A reader's toggle: remembered. */
  readonly setOpen: (open: boolean) => void;
  /** Closes without changing the remembered choice (after a jump while it covers the PDF). */
  readonly dismiss: () => void;
  /** Focus moves into the panel only when a reader opened it, not when restored on load. */
  readonly onOpenAutoFocus: NonNullable<FloatingSidePanelProps['onOpenAutoFocus']>;
}

export function useOutlinePanel(): OutlinePanelState {
  const [stored, store] = usePreference(OUTLINE_STORAGE_KEY);
  const beside = useMediaQuery(OUTLINE_BESIDE_QUERY);
  /** A close that is not remembered (dismiss); cleared by the next toggle. */
  const [dismissed, setDismissed] = useState(false);
  const focusOnOpen = useRef(false);
  const open =
    beside === null
      ? null
      : !dismissed && (stored === 'open' ? true : stored === 'closed' ? false : beside);
  const setOpen = useCallback(
    (next: boolean) => {
      focusOnOpen.current = next;
      setDismissed(false);
      store(next ? 'open' : 'closed');
    },
    [store],
  );
  const dismiss = useCallback(() => setDismissed(true), []);
  const onOpenAutoFocus = useCallback((event: Event) => {
    if (!focusOnOpen.current) event.preventDefault();
    focusOnOpen.current = false;
  }, []);
  return { open, beside, setOpen, dismiss, onOpenAutoFocus };
}

/** `auto` until hydrated: the CSS then keeps the desktop default (open) without a layout shift. */
export function outlineLayout(open: boolean | null): 'auto' | 'open' | 'closed' {
  return open === null ? 'auto' : open ? 'open' : 'closed';
}

export interface OutlinePanelProps {
  readonly state: OutlinePanelState;
  /** Portal target inside the page's main landmark. */
  readonly container: HTMLElement | null;
  readonly children: ReactNode;
}

/** The `목차` toggle (rendered where it is placed, e.g. the PDF toolbar) and its panel. */
export function OutlinePanel({ state, container, children }: OutlinePanelProps) {
  return (
    <FloatingSidePanel
      open={state.open === true}
      onOpenChange={state.setOpen}
      modal={false}
      side="start"
      size="narrow"
      title="목차"
      closeLabel="목차 닫기"
      container={container}
      className={styles.outlinePanel}
      trigger={
        <Button size="sm" variant="ghost">
          목차
        </Button>
      }
      onOpenAutoFocus={state.onOpenAutoFocus}
    >
      {children}
    </FloatingSidePanel>
  );
}
