'use client';

// DOC-02-AC10 (DOCVIEW): the separator between the PDF and the text pane. A focusable WAI-ARIA
// window splitter (role="separator", aria-valuenow = the PDF pane's share in %): pointer drag
// (mouse, pen, touch — touch-action none), ←/→ 5%, Shift+←/→ 10%, Home/End to the limits, Enter
// back to the default. The share stays within 25–75% and is remembered in this browser.
import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { usePreference } from '@/lib/documents/viewer-preferences';
import styles from './editor.module.css';

export const SPLIT_STORAGE_KEY = 'quiz:doc02:split';
export const SPLIT_DEFAULT = 55;
export const SPLIT_MIN = 25;
export const SPLIT_MAX = 75;
const STEP = 5;
const BIG_STEP = 10;

export function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_DEFAULT;
  return Math.min(Math.max(Math.round(value), SPLIT_MIN), SPLIT_MAX);
}

/**
 * The PDF pane's share (%): the remembered one after hydration, a live value while dragging.
 * Returns [share, set while dragging, commit (also remembered)].
 */
export function useSplitRatio(): [number, (value: number) => void, (value: number) => void] {
  const [stored, store] = usePreference(SPLIT_STORAGE_KEY);
  const [dragged, setDragged] = useState<number | null>(null);
  const ratio = dragged ?? (stored === null ? SPLIT_DEFAULT : clampSplit(Number(stored)));
  const set = useCallback((value: number) => setDragged(clampSplit(value)), []);
  const commit = useCallback(
    (value: number) => {
      setDragged(null);
      store(String(clampSplit(value)));
    },
    [store],
  );
  return [ratio, set, commit];
}

/** Grid column shares for the split container (editor.module.css `.split`). */
export function splitStyle(share: number): CSSProperties {
  return { '--pdf-share': `${share}fr`, '--text-share': `${100 - share}fr` } as CSSProperties;
}

export interface PaneSplitterProps {
  readonly value: number;
  /** While dragging (not remembered yet). */
  readonly onChange: (value: number) => void;
  /** A finished drag or key press. */
  readonly onCommit: (value: number) => void;
  /** The split container whose width the share is measured against. */
  readonly containerRef: RefObject<HTMLElement | null>;
  /** Id of the PDF pane (aria-controls). */
  readonly controls: string;
}

export function PaneSplitter({
  value,
  onChange,
  onCommit,
  containerRef,
  controls,
}: PaneSplitterProps) {
  const dragging = useRef<number | null>(null);
  const [active, setActive] = useState(false);

  const shareAt = (clientX: number): number | null => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return null;
    return clampSplit(((clientX - box.left) / box.width) * 100);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = event.pointerId;
    setActive(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current !== event.pointerId) return;
    const share = shareAt(event.clientX);
    if (share !== null) onChange(share);
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current !== event.pointerId) return;
    dragging.current = null;
    setActive(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onCommit(shareAt(event.clientX) ?? value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = value - step;
        break;
      case 'ArrowRight':
        next = value + step;
        break;
      case 'Home':
        next = SPLIT_MIN;
        break;
      case 'End':
        next = SPLIT_MAX;
        break;
      case 'Enter':
        next = SPLIT_DEFAULT;
        break;
      default:
        return;
    }
    event.preventDefault();
    onCommit(next);
  };

  return (
    // A focusable separator is a widget (WAI-ARIA window splitter pattern), not static content.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="separator"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="PDF와 원문 폭 조정"
      aria-controls={controls}
      aria-valuenow={value}
      aria-valuemin={SPLIT_MIN}
      aria-valuemax={SPLIT_MAX}
      aria-valuetext={`PDF ${value}%, 원문 ${100 - value}%`}
      className={`${styles.splitter} qz-focus-ring`}
      data-active={active || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
    >
      <span className={styles.splitterGrip} aria-hidden="true" />
    </div>
  );
}
