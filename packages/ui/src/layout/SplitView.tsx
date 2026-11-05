'use client';

import {
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { cx } from '../internal/cx';
import { focusRingClassName } from '../primitives/FocusRing';

/** `horizontal` = panes side by side (좌우), `vertical` = stacked (상하). */
export type SplitViewOrientation = 'horizontal' | 'vertical';

export interface SplitViewProps {
  /** Split axis. The separator's `aria-orientation` is the opposite (a 좌우 split has a vertical bar). */
  orientation?: SplitViewOrientation;
  /** The first pane's share in % (controlled). Omit for an uncontrolled split starting at `defaultRatio`. */
  ratio?: number;
  /** Ratio restored by Enter and double click / double tap (and the uncontrolled start). Default 50. */
  defaultRatio?: number;
  /** Every change: each drag step, key press and reset. Integer %, already clamped. */
  onRatioChange?: (ratio: number) => void;
  /** A finished change: pointer release, key press, reset. Persist here, not in `onRatioChange`. */
  onRatioCommit?: (ratio: number) => void;
  /** Minimum share of either pane in %. Default 20. */
  minRatio?: number;
  /**
   * Minimum size of either pane in px along the split axis, as one number or per orientation
   * (e.g. `{ horizontal: 320, vertical: 200 }`). When both minimums do not fit, the split stays
   * 50:50 and the separator does not move (valuemin = valuemax = 50). Default 0.
   */
  minSize?: number | Partial<Record<SplitViewOrientation, number>>;
  /** Accessible name of the separator (required; the copy lives with the screen). */
  separatorLabel: string;
  /** `aria-valuetext` for a first-pane ratio, e.g. `(r) => \`원본 ${r}%, 변환본 ${100 - r}%\``. */
  valueText?: (ratio: number) => string;
  /**
   * Which panes are shown. A hidden pane stays mounted with the `hidden` attribute (inputs, scroll
   * positions and canvases survive); the separator is shown only for `both`.
   */
  visible?: 'both' | 'first' | 'second';
  /**
   * The two panes, in order. To swap the panes, give both children distinct `key`s and swap their
   * order: each pane lives in a wrapper keyed by its child's key, so a swap moves the existing DOM
   * (inputs, PDF state, scroll positions survive) instead of remounting it.
   */
  children: readonly [ReactNode, ReactNode];
  className?: string;
  style?: CSSProperties;
}

const KEY_STEP = 5;
const DOUBLE_TAP_MS = 350;
const TAP_SLOP_PX = 6;

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Wall-clock ms for double-tap detection (outside render; a function so tests can fake it). */
function currentTime(): number {
  return Date.now();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Allowed first-pane range in integer % for `available` px of pane space. `null` (not measured
 * yet, or not laid out) applies `minRatio` only.
 */
export function splitRange(
  available: number | null,
  minRatio: number,
  minPx: number,
): { min: number; max: number } {
  let minPercent = clamp(minRatio, 0, 50);
  if (available !== null && available > 0 && minPx > 0) {
    minPercent = Math.max(minPercent, (100 * minPx) / available);
  }
  const min = Math.ceil(minPercent - 1e-9);
  const max = Math.floor(100 - minPercent + 1e-9);
  return min > max || minPercent >= 50 ? { min: 50, max: 50 } : { min, max };
}

interface DragState {
  pointerId: number;
  start: number;
  startRatio: number;
  available: number;
  moved: boolean;
  last: number;
}

/**
 * Two panes and a resizable separator (docs/design-system.md §7 `SplitView`). The separator is a
 * focusable `role="separator"` with `aria-valuenow` = the first pane's %, arrow keys on the split
 * axis (±5), Home/End (min/max), Enter and double click / double tap (reset), and Pointer Events
 * drags (mouse, touch, pen) with pointer capture and no text selection.
 */
export function SplitView({
  orientation = 'horizontal',
  ratio,
  defaultRatio = 50,
  onRatioChange,
  onRatioCommit,
  minRatio = 20,
  minSize = 0,
  separatorLabel,
  valueText,
  visible = 'both',
  children,
  className,
  style,
}: SplitViewProps) {
  const firstId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [uncontrolled, setUncontrolled] = useState(defaultRatio);
  const [available, setAvailable] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const lastTapRef = useRef(0);

  const horizontal = orientation === 'horizontal';
  const minPx = typeof minSize === 'number' ? minSize : (minSize[orientation] ?? 0);
  const range = splitRange(available, minRatio, minPx);
  const requested = ratio ?? uncontrolled;
  const current = Math.round(clamp(requested, range.min, range.max));
  const both = visible === 'both';

  /** The two pane wrappers in their current (visual) order. */
  const panes = useCallback((): [HTMLElement, HTMLElement] | null => {
    const found = rootRef.current?.querySelectorAll<HTMLElement>(':scope > .pane');
    return found && found.length === 2 && found[0] && found[1] ? [found[0], found[1]] : null;
  }, []);

  const measurePaneSpace = useCallback((): number | null => {
    const pair = panes();
    if (!pair || pair[0].hidden || pair[1].hidden) return null;
    const [first, second] = pair;
    const a = first.getBoundingClientRect();
    const b = second.getBoundingClientRect();
    const size = horizontal ? a.width + b.width : a.height + b.height;
    return size > 0 ? size : null;
  }, [horizontal, panes]);

  const measure = useCallback(() => {
    const pair = panes();
    if (!pair || pair[0].hidden || pair[1].hidden) return;
    const next = measurePaneSpace();
    setAvailable((prev) => (prev === next ? prev : next));
  }, [measurePaneSpace, panes]);

  useIsomorphicLayoutEffect(() => {
    measure();
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    return () => observer.disconnect();
  }, [measure, visible]);

  const change = (next: number, commit: boolean, bounds = range, previous = current) => {
    const value = Math.round(clamp(next, bounds.min, bounds.max));
    if (ratio === undefined) setUncontrolled(value);
    if (value !== previous) onRatioChange?.(value);
    if (commit) onRatioCommit?.(value);
  };

  const eventSnapshot = () => {
    const measured = measurePaneSpace();
    if (measured !== null) setAvailable(measured);
    const bounds = splitRange(measured ?? available, minRatio, minPx);
    return { bounds, current: Math.round(clamp(requested, bounds.min, bounds.max)) };
  };

  const reset = () => {
    const snapshot = eventSnapshot();
    change(defaultRatio, true, snapshot.bounds, snapshot.current);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const decrease = horizontal ? 'ArrowLeft' : 'ArrowUp';
    const increase = horizontal ? 'ArrowRight' : 'ArrowDown';
    if (![decrease, increase, 'Home', 'End', 'Enter'].includes(event.key)) return;
    // ResizeObserver may not have reported a recent viewport change yet. Read the panes now so
    // an immediate key cannot use stale limits or jump from an out-of-range displayed value.
    const { bounds, current: liveCurrent } = eventSnapshot();
    let next = defaultRatio;
    if (event.key === decrease) next = liveCurrent - KEY_STEP;
    else if (event.key === increase) next = liveCurrent + KEY_STEP;
    else if (event.key === 'Home') next = bounds.min;
    else if (event.key === 'End') next = bounds.max;
    event.preventDefault();
    change(next, true, bounds, liveCurrent);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const pair = panes();
    if (!pair) return;
    const [first, second] = pair;
    // No text selection starts from the bar (the panes also get user-select: none while dragging).
    event.preventDefault();
    const a = first.getBoundingClientRect();
    const b = second.getBoundingClientRect();
    const size = horizontal ? a.width + b.width : a.height + b.height;
    setAvailable(size > 0 ? size : null);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic or already-released pointers cannot be captured; moves still reach the bar.
    }
    const bounds = splitRange(size > 0 ? size : null, minRatio, minPx);
    const startRatio = Math.round(clamp(requested, bounds.min, bounds.max));
    dragRef.current = {
      pointerId: event.pointerId,
      start: horizontal ? event.clientX : event.clientY,
      startRatio,
      available: size,
      moved: false,
      last: startRatio,
    };
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.available <= 0) return;
    const measured = measurePaneSpace();
    if (measured !== null && Math.abs(measured - drag.available) > 0.5) {
      // Cancel a gesture across a resize, retaining its last valid share under the new limits.
      const bounds = splitRange(measured, minRatio, minPx);
      const value = Math.round(clamp(drag.last, bounds.min, bounds.max));
      setAvailable(measured);
      dragRef.current = null;
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch {
        // Nothing captured.
      }
      setDragging(false);
      if (drag.moved) {
        if (value !== drag.last) {
          if (ratio === undefined) setUncontrolled(value);
          onRatioChange?.(value);
        }
        onRatioCommit?.(value);
      }
      return;
    }
    const delta = (horizontal ? event.clientX : event.clientY) - drag.start;
    if (!drag.moved && Math.abs(delta) < TAP_SLOP_PX && event.pointerType !== 'mouse') return;
    if (delta !== 0) drag.moved = true;
    const range2 = splitRange(drag.available, minRatio, minPx);
    const next = Math.round(
      clamp(drag.startRatio + (100 * delta) / drag.available, range2.min, range2.max),
    );
    if (next === drag.last) return;
    drag.last = next;
    if (ratio === undefined) setUncontrolled(next);
    onRatioChange?.(next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Nothing captured.
    }
    if (drag.moved) {
      const measured = measurePaneSpace();
      if (measured !== null) setAvailable(measured);
      const bounds = splitRange(measured ?? drag.available, minRatio, minPx);
      const value = Math.round(clamp(drag.last, bounds.min, bounds.max));
      if (value !== drag.last) {
        if (ratio === undefined) setUncontrolled(value);
        onRatioChange?.(value);
      }
      onRatioCommit?.(value);
      return;
    }
    // A tap without movement: two quick taps reset (touch and pen have no reliable dblclick).
    if (cancelled || event.pointerType === 'mouse') return;
    const now = currentTime();
    if (now - lastTapRef.current <= DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      reset();
    } else {
      lastTapRef.current = now;
    }
  };

  const track = (r: number) => `minmax(0, ${r}fr) var(--qz-split-gutter) minmax(0, ${100 - r}fr)`;
  const gridStyle: CSSProperties = both
    ? horizontal
      ? { gridTemplateColumns: track(current), gridTemplateRows: 'minmax(0, 1fr)' }
      : { gridTemplateRows: track(current), gridTemplateColumns: 'minmax(0, 1fr)' }
    : { gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1fr)' };

  // Wrapper keys follow the children's keys, so swapping keyed children reorders the wrappers.
  const childKey = (child: ReactNode) =>
    isValidElement(child) && child.key !== null ? String(child.key) : null;
  const k0 = childKey(children[0]);
  const k1 = childKey(children[1]);
  const [key0, key1] =
    k0 !== null && k1 !== null && k0 !== k1 ? [`pane-${k0}`, `pane-${k1}`] : ['pane-0', 'pane-1'];

  return (
    <div
      ref={rootRef}
      className={cx('qz-split', className)}
      data-orientation={orientation}
      data-visible={visible}
      data-dragging={dragging || undefined}
      style={{ ...gridStyle, ...style }}
    >
      <div key={key0} id={firstId} className="pane" hidden={visible === 'second'}>
        {children[0]}
      </div>
      {/* A focusable separator is an interactive widget (WAI-ARIA window splitter pattern). */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        key="separator"
        role="separator"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={both ? 0 : -1}
        hidden={!both}
        aria-label={separatorLabel}
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-valuenow={current}
        aria-valuemin={range.min}
        aria-valuemax={range.max}
        aria-valuetext={valueText?.(current)}
        aria-controls={firstId}
        className={cx('separator', focusRingClassName)}
        data-dragging={dragging || undefined}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, false)}
        onPointerCancel={(event) => endDrag(event, true)}
        onLostPointerCapture={(event) => {
          // Capture lost mid-drag (e.g. the element moved): keep what was dragged so far.
          if (dragRef.current?.pointerId === event.pointerId) endDrag(event, true);
        }}
        onDoubleClick={reset}
      >
        <span className="line" aria-hidden="true" />
        <span className="grip" aria-hidden="true" />
      </div>
      <div key={key1} className="pane" hidden={visible === 'first'}>
        {children[1]}
      </div>
    </div>
  );
}
