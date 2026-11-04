'use client';

import { Popover as RadixPopover, Slot } from 'radix-ui';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cx } from '../internal/cx';
import { PopoverContent } from './Popover';
import { PREVIEW_CLOSE_MS, PREVIEW_LONG_PRESS_MS, TOOLTIP_DELAY_MS } from './tooltip-delay';

/** A touch that moves farther than this (px) is a scroll or drag, not a long-press. */
const PRESS_SLOP = 10;
/** A swallowed release click that never arrives (real touch fires none) is forgotten after this. */
const SWALLOW_MS = 1000;

export type PreviewTooltipMode = 'hover' | 'focus' | 'touch';

export interface PreviewTooltipProps {
  /** One focusable trigger (e.g. a button). Its own handlers keep working. */
  children: ReactElement;
  /**
   * Preview content, rendered as-is inside `role="tooltip"` (non-interactive). The caller owns the
   * loading (`role="status"`) and failure texts. Mounted only while the preview is open.
   */
  content: ReactNode;
  /** Called when the preview opens or closes (e.g. to start loading on the first open). */
  onOpenChange?: (open: boolean, mode: PreviewTooltipMode) => void;
  /** Hover delay in ms (default `TOOLTIP_DELAY_MS`); keyboard focus-visible opens at once. */
  delay?: number;
  /** Touch long-press duration in ms (default `PREVIEW_LONG_PRESS_MS`). */
  longPressMs?: number;
  disabled?: boolean;
  side?: 'top' | 'bottom';
  className?: string;
}

// Last input modality, for engines without `:focus-visible` matching on the trigger.
let keyboardModality = true;
let modalityTracked = false;

function trackModality(doc: Document) {
  if (modalityTracked) return;
  modalityTracked = true;
  doc.addEventListener(
    'keydown',
    (event) => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey) keyboardModality = true;
    },
    true,
  );
  doc.addEventListener(
    'pointerdown',
    () => {
      keyboardModality = false;
    },
    true,
  );
}

function focusVisible(el: Element): boolean {
  try {
    if (el.matches(':focus-visible')) return true;
  } catch {
    // Older engines: fall back to the modality.
  }
  return keyboardModality;
}

/** Keeps the iOS/Android press-and-hold callout from covering the preview. */
const TRIGGER_STYLE = { WebkitTouchCallout: 'none' } as CSSProperties;

/**
 * Rich preview that hangs from a trigger (design-system §5.6): opens on hover (after the tooltip
 * delay), on keyboard `:focus-visible` and on a touch long-press (500 ms, pointer events), and
 * describes the trigger (`aria-describedby`) while open. Built on Radix Popover so it layers above
 * its panel and Escape dismisses only the preview (never the panel under it).
 *
 * Touch rules: a long-press opens the preview and the release click that follows is swallowed, so
 * the trigger's own click (a dialog) does not fire; a short tap passes the click through (and
 * closes the preview). While a preview is open, a touch outside it and the trigger closes it and
 * that tap's click is consumed — nothing underneath (not even a backdrop) receives it.
 * Hover and focus previews close when the pointer leaves both, or the trigger blurs. After a click
 * the focus that returns to the trigger does not reopen it.
 */
export function PreviewTooltip({
  children,
  content,
  onOpenChange,
  delay = TOOLTIP_DELAY_MS,
  longPressMs = PREVIEW_LONG_PRESS_MS,
  disabled = false,
  side = 'bottom',
  className,
}: PreviewTooltipProps) {
  const contentId = useId();
  const [mode, setMode] = useState<PreviewTooltipMode | null>(null);
  const modeRef = useRef<PreviewTooltipMode | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const timers = useRef<{ open?: number; close?: number; press?: number; swallow?: number }>({});
  const press = useRef<{ x: number; y: number } | null>(null);
  /** The release click of a long-press is swallowed. */
  const swallowClick = useRef(false);
  /** After a click, focus coming back to the trigger must not reopen the preview. */
  const clicked = useRef(false);
  const changed = useRef(onOpenChange);
  useEffect(() => {
    changed.current = onOpenChange;
  });

  const anchor = useRef({
    getBoundingClientRect: (): DOMRect =>
      triggerRef.current?.getBoundingClientRect() ?? new DOMRect(),
  });

  const clearTimers = useCallback(() => {
    window.clearTimeout(timers.current.open);
    window.clearTimeout(timers.current.close);
  }, []);

  const show = useCallback(
    (next: PreviewTooltipMode) => {
      clearTimers();
      if (modeRef.current === next) return;
      modeRef.current = next;
      setMode(next);
      changed.current?.(true, next);
    },
    [clearTimers],
  );

  const hide = useCallback(() => {
    clearTimers();
    const was = modeRef.current;
    if (was === null) return;
    modeRef.current = null;
    setMode(null);
    changed.current?.(false, was);
  }, [clearTimers]);

  const hideSoon = useCallback(() => {
    window.clearTimeout(timers.current.close);
    timers.current.close = window.setTimeout(hide, PREVIEW_CLOSE_MS);
  }, [hide]);

  useEffect(() => {
    trackModality(document);
    const pending = timers.current;
    return () => {
      window.clearTimeout(pending.open);
      window.clearTimeout(pending.close);
      window.clearTimeout(pending.press);
      window.clearTimeout(pending.swallow);
    };
  }, []);

  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  // A press outside the preview and its trigger closes it; a touch also consumes the click that
  // follows, so the dismissing tap reaches nothing underneath (backdrop, buttons).
  useEffect(() => {
    if (mode === null) return undefined;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (floatingRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      if (event.pointerType === 'touch') {
        const swallow = (click: Event) => {
          click.preventDefault();
          click.stopPropagation();
          document.removeEventListener('click', swallow, true);
          window.clearTimeout(timer);
        };
        const timer = window.setTimeout(
          () => document.removeEventListener('click', swallow, true),
          SWALLOW_MS,
        );
        document.addEventListener('click', swallow, true);
      }
      hide();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      // A pending click swallow removes itself on the click or its own timeout.
    };
  }, [mode, hide]);

  const endPress = () => {
    window.clearTimeout(timers.current.press);
    press.current = null;
  };

  const setTrigger = useCallback((el: HTMLElement | null) => {
    triggerRef.current = el;
  }, []);

  return (
    <RadixPopover.Root
      open={mode !== null}
      onOpenChange={(next) => {
        if (!next) hide();
      }}
    >
      <RadixPopover.Anchor virtualRef={anchor} />
      {/* Radix Slot merges these into the child (its own handlers run first, refs compose). */}
      <Slot.Root
        ref={setTrigger}
        style={TRIGGER_STYLE}
        aria-describedby={mode ? contentId : undefined}
        onPointerDown={(event: PointerEvent<HTMLElement>) => {
          clicked.current = false;
          swallowClick.current = false;
          window.clearTimeout(timers.current.swallow);
          endPress();
          if (disabled || event.pointerType !== 'touch') return;
          press.current = { x: event.clientX, y: event.clientY };
          timers.current.press = window.setTimeout(() => {
            swallowClick.current = true;
            show('touch');
          }, longPressMs);
        }}
        onPointerMove={(event: PointerEvent<HTMLElement>) => {
          const from = press.current;
          if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > PRESS_SLOP) {
            endPress();
          }
        }}
        onPointerUp={() => {
          endPress();
          // Real touch fires no click after a long-press; forget the swallow so a later keyboard
          // activation is not eaten. The synthetic sequence clicks right after the release.
          if (swallowClick.current) {
            window.clearTimeout(timers.current.swallow);
            timers.current.swallow = window.setTimeout(() => {
              swallowClick.current = false;
            }, SWALLOW_MS);
          }
        }}
        onPointerCancel={() => {
          endPress();
          swallowClick.current = false;
        }}
        onContextMenu={(event: MouseEvent<HTMLElement>) => {
          // The long-press menu of touch browsers must not open over the preview.
          if (press.current || swallowClick.current) event.preventDefault();
        }}
        onPointerEnter={(event: PointerEvent<HTMLElement>) => {
          if (disabled || event.pointerType === 'touch') return;
          clicked.current = false;
          window.clearTimeout(timers.current.close);
          if (modeRef.current) return;
          window.clearTimeout(timers.current.open);
          timers.current.open = window.setTimeout(() => show('hover'), delay);
        }}
        onPointerLeave={(event: PointerEvent<HTMLElement>) => {
          if (event.pointerType === 'touch') return;
          window.clearTimeout(timers.current.open);
          if (modeRef.current === 'hover') hideSoon();
        }}
        onFocus={(event: FocusEvent<HTMLElement>) => {
          if (disabled || modeRef.current || clicked.current) return;
          if (focusVisible(event.currentTarget)) show('focus');
        }}
        onBlur={(event: FocusEvent<HTMLElement>) => {
          const next = event.relatedTarget;
          if (next instanceof Node && floatingRef.current?.contains(next)) return;
          // Focus moving into the dialog this click opened keeps "just clicked" until it comes
          // back. That is a dialog other than the one holding the trigger: a sibling control in
          // the trigger's own panel is not it, and moving there ends the "just clicked" state.
          const home = event.currentTarget.closest('[role="dialog"]');
          const into = next instanceof Element ? next.closest('[role="dialog"]') : null;
          const intoOpened = into !== null && into !== home;
          if (!intoOpened && next !== null) clicked.current = false;
          if (modeRef.current && modeRef.current !== 'hover') hide();
        }}
        onClickCapture={(event: MouseEvent<HTMLElement>) => {
          if (swallowClick.current) {
            // The release of a long-press is not a click (capture phase: the trigger's own click
            // handler and default action never run).
            swallowClick.current = false;
            window.clearTimeout(timers.current.swallow);
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          clicked.current = true;
          hide();
        }}
      >
        {children}
      </Slot.Root>
      {mode ? (
        <PopoverContent
          ref={floatingRef}
          id={contentId}
          role="tooltip"
          side={side}
          align="start"
          sideOffset={6}
          collisionPadding={16}
          className={cx('qz-preview-tooltip', className)}
          data-mode={mode}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          // Outside presses are handled above (the touch one must also consume its click).
          onPointerDownOutside={(event) => event.preventDefault()}
          onFocusOutside={(event) => event.preventDefault()}
          onPointerEnter={() => window.clearTimeout(timers.current.close)}
          onPointerLeave={() => {
            if (modeRef.current === 'hover') hideSoon();
          }}
        >
          {content}
        </PopoverContent>
      ) : null}
    </RadixPopover.Root>
  );
}
