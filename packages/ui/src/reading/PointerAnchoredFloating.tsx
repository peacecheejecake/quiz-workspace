'use client';

import { Popover as RadixPopover, Slot } from 'radix-ui';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cx } from '../internal/cx';
import { PopoverContent } from '../primitives/Popover';
import { TOOLTIP_DELAY_MS } from '../primitives/tooltip-delay';

/** The floating closes this long after the pointer left both the trigger and the floating. */
export const POINTER_FLOATING_CLOSE_MS = 120;
/** Offset (px) of the floating from the pointer, down and to the right. */
const POINTER_OFFSET = 8;

export type PointerFloatingMode = 'hover' | 'focus' | 'tap';

type FloatingContent =
  ReactNode | ((ctx: { mode: PointerFloatingMode; close: () => void }) => ReactNode);

export interface PointerAnchoredFloatingProps {
  /**
   * One focusable trigger element (e.g. a footnote link). Its own handlers keep working; give it
   * no `aria-describedby` of its own (the floating describes it while open).
   */
  children: ReactElement;
  /** Floating content; a function gets the opening mode (touch → `tap`) and a close callback. */
  content: FloatingContent;
  /** Name of the non-modal dialog a tap opens (its content has buttons), e.g. "문제 미리보기". */
  label: string;
  /**
   * Touch (no hover): a tap opens the floating as a dialog instead of activating the trigger.
   * Without it a tap activates the trigger as usual and nothing floats.
   */
  openOnTap?: boolean;
  /** Hover delay in ms (default `TOOLTIP_DELAY_MS`); keyboard focus opens at once. */
  delay?: number;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

interface OpenState {
  readonly mode: PointerFloatingMode;
  /** Viewport point the floating hangs from; null = the trigger's own box (keyboard). */
  readonly point: { readonly x: number; readonly y: number } | null;
}

// Last input modality, for engines without `:focus-visible` matching (and programmatic focus
// right after a key press). Listeners are installed once, by the first mounted instance.
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

function withinGap(box: DOMRect, x: number, y: number): boolean {
  return (
    x >= box.left - POINTER_OFFSET &&
    x <= box.right + POINTER_OFFSET &&
    y >= box.top - POINTER_OFFSET &&
    y <= box.bottom + POINTER_OFFSET
  );
}

function FloatingBody({
  content,
  mode,
  close,
}: {
  content: FloatingContent;
  mode: PointerFloatingMode;
  close: () => void;
}) {
  return <>{typeof content === 'function' ? content({ mode, close }) : content}</>;
}

/**
 * Hover preview hung from the point where the pointer entered (design-system §5.4): opens after
 * `delay` at the last pointer position and then stays put; keyboard focus-visible opens it at once
 * on the trigger itself; a touch tap opens it (as a dialog) when `openOnTap`. It closes 120 ms
 * after the pointer left trigger and floating (the gap around the floating counts as the floating,
 * however slowly the pointer crosses it), on Escape (only the floating), on blur and when a
 * container scrolls. Non-interactive content is a `role="tooltip"` describing the trigger.
 */
export function PointerAnchoredFloating({
  children,
  content,
  label,
  openOnTap = false,
  delay = TOOLTIP_DELAY_MS,
  disabled = false,
  onOpenChange,
  className,
}: PointerAnchoredFloatingProps) {
  const contentId = useId();
  const [state, setState] = useState<OpenState | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const point = useRef<{ x: number; y: number } | null>(null);
  const lastPointer = useRef<string>('mouse');
  /** Focus going back to the trigger after a tapped dialog closes must not reopen it. */
  const refocusing = useRef(false);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const stateRef = useRef(state);
  const changed = useRef(onOpenChange);
  useEffect(() => {
    stateRef.current = state;
    changed.current = onOpenChange;
  });

  const anchor = useRef({
    getBoundingClientRect: (): DOMRect => {
      const at = stateRef.current?.point;
      if (at) return new DOMRect(at.x, at.y, 0, 0);
      return triggerRef.current?.getBoundingClientRect() ?? new DOMRect();
    },
  });

  const cancelClose = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }, []);

  const show = useCallback(
    (next: OpenState) => {
      window.clearTimeout(openTimer.current);
      cancelClose();
      stateRef.current = next;
      setState(next);
      changed.current?.(true);
    },
    [cancelClose],
  );

  const hide = useCallback(() => {
    window.clearTimeout(openTimer.current);
    cancelClose();
    if (stateRef.current === null) return;
    stateRef.current = null;
    setState(null);
    changed.current?.(false);
  }, [cancelClose]);

  const hideSoon = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(hide, POINTER_FLOATING_CLOSE_MS);
  }, [cancelClose, hide]);

  useEffect(() => {
    trackModality(document);
    return () => {
      window.clearTimeout(openTimer.current);
      cancelClose();
    };
  }, [cancelClose]);

  // Scrolling the page or a container closes it (not scrolling inside the floating).
  useEffect(() => {
    if (!state) return undefined;
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && floatingRef.current?.contains(target)) return;
      hide();
    };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [state, hide]);

  // The floating hangs `POINTER_OFFSET` from the pointer, so reaching it means crossing a gap that
  // is neither trigger nor floating: that gap counts as the floating, at any pointer speed.
  const hovering = state?.mode === 'hover';
  useEffect(() => {
    if (!hovering) return undefined;
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const box = floatingRef.current?.getBoundingClientRect();
      if (box && withinGap(box, event.clientX, event.clientY)) {
        cancelClose();
        return;
      }
      const onTrigger = event.target instanceof Node && triggerRef.current?.contains(event.target);
      if (!onTrigger && closeTimer.current === undefined) hideSoon();
    };
    document.addEventListener('pointermove', onPointerMove, true);
    return () => document.removeEventListener('pointermove', onPointerMove, true);
  }, [hovering, cancelClose, hideSoon]);

  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  const setTrigger = useCallback((el: HTMLElement | null) => {
    triggerRef.current = el;
  }, []);

  const mode = state?.mode ?? 'hover';
  const asDialog = mode === 'tap';

  return (
    <RadixPopover.Root
      open={state !== null}
      onOpenChange={(next) => {
        if (!next) hide();
      }}
    >
      <RadixPopover.Anchor virtualRef={anchor} />
      {/* Radix Slot merges these into the child (its own handlers run first, refs compose). */}
      <Slot.Root
        ref={setTrigger}
        aria-describedby={state && !asDialog ? contentId : undefined}
        onPointerDown={(event: PointerEvent<HTMLElement>) => {
          lastPointer.current = event.pointerType;
          point.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerEnter={(event: PointerEvent<HTMLElement>) => {
          lastPointer.current = event.pointerType;
          if (disabled || event.pointerType === 'touch') return;
          cancelClose();
          point.current = { x: event.clientX, y: event.clientY };
          if (stateRef.current) return;
          window.clearTimeout(openTimer.current);
          openTimer.current = window.setTimeout(() => {
            show({ mode: 'hover', point: point.current });
          }, delay);
        }}
        onPointerMove={(event: PointerEvent<HTMLElement>) => {
          // Until it opens the floating follows the pointer; once open it stays put.
          if (!stateRef.current && event.pointerType !== 'touch') {
            point.current = { x: event.clientX, y: event.clientY };
          }
        }}
        onPointerLeave={() => {
          window.clearTimeout(openTimer.current);
          if (stateRef.current?.mode === 'hover') hideSoon();
        }}
        onFocus={(event: FocusEvent<HTMLElement>) => {
          if (disabled || stateRef.current || refocusing.current) return;
          if (focusVisible(event.currentTarget)) show({ mode: 'focus', point: null });
        }}
        onBlur={(event: FocusEvent<HTMLElement>) => {
          const next = event.relatedTarget;
          if (next instanceof Node && floatingRef.current?.contains(next)) return;
          if (stateRef.current && stateRef.current.mode !== 'hover') hide();
        }}
        onClickCapture={(event: MouseEvent<HTMLElement>) => {
          // Touch: the tap opens the preview instead of activating the trigger (capture phase,
          // so the trigger's own click handler and default action never run).
          if (openOnTap && !disabled && lastPointer.current === 'touch') {
            event.preventDefault();
            event.stopPropagation();
            show({ mode: 'tap', point: point.current });
          }
        }}
      >
        {children}
      </Slot.Root>
      {state ? (
        <PopoverContent
          ref={floatingRef}
          id={contentId}
          role={asDialog ? 'dialog' : 'tooltip'}
          aria-label={asDialog ? label : undefined}
          side="bottom"
          align="start"
          sideOffset={POINTER_OFFSET}
          alignOffset={state.point ? POINTER_OFFSET : 0}
          collisionPadding={16}
          className={cx('qz-pointer-floating', className)}
          data-mode={mode}
          onOpenAutoFocus={(event) => {
            // A hover or focus preview never takes focus; a tapped dialog does.
            if (!asDialog) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!asDialog) return;
            refocusing.current = true;
            triggerRef.current?.focus({ preventScroll: true });
            refocusing.current = false;
          }}
          onFocusOutside={(event) => {
            // The trigger is a Slot, not a Radix trigger: focus landing on it (the keyboard focus
            // that opened the floating) is not "outside".
            const target = event.target;
            if (target instanceof Node && triggerRef.current?.contains(target)) {
              event.preventDefault();
            }
          }}
          onPointerEnter={cancelClose}
          onPointerLeave={() => {
            if (stateRef.current?.mode === 'hover') hideSoon();
          }}
        >
          <FloatingBody content={content} mode={mode} close={hide} />
        </PopoverContent>
      ) : null}
    </RadixPopover.Root>
  );
}
