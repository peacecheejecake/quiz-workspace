'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { cx } from '../internal/cx';
import { useMergedRefs } from '../internal/merge-refs';
import { BLOCK_ATTR, SKIP_ATTR, rangeText, readSelection, selectionOf } from './dom-selection';
import {
  drawableHighlights,
  highlightColorLabels,
  textSegments,
  type HighlightSelection,
  type SelectionSource,
  type TextBlock,
  type TextHighlight,
  type TextMatch,
  type TextSegment,
} from './model';

/** A touch selection must rest this long before the menu opens (HILITE-01 "터치"). */
export const TOUCH_SELECTION_REST_MS = 300;
/** A press may move this far (px) between pointerdown and pointerup; more is a swipe. */
const PRESS_SLOP_PX = 10;

const SKIP = { [SKIP_ATTR]: '' } as const;

export type HighlightBlockElement = 'p' | 'li' | 'div' | 'span';

/** Renders block `id` where the layout wants it (sections, lists...). */
export type RenderHighlightBlock = (
  id: string,
  options?: { readonly as?: HighlightBlockElement; readonly className?: string },
) => ReactNode;

export interface HighlightableTextProps {
  /** Accessible name of the area, e.g. "정리 노트 본문" or "해설". */
  label: string;
  blocks: readonly TextBlock[];
  /** The reader's highlights (non-overlapping; overlaps are not drawn). */
  highlights?: readonly TextHighlight[];
  /** Search results drawn over the text and highlights (CHNOTE-02). */
  matches?: readonly TextMatch[];
  /** Scrolls the `current` match into view when it changes (default true). */
  scrollToCurrentMatch?: boolean;
  /** No highlight presses (selection is still reported, e.g. for a copy-only menu). */
  readOnly?: boolean;
  /**
   * The reader picked text (mouse, touch, keyboard) or pressed a highlight; null when the pick is
   * gone or changed. Pass it to `HighlightMenu`.
   */
  onSelectRange?: (selection: HighlightSelection | null) => void;
  /** A highlight was pressed (click, tap, Enter on a focused mark). */
  onHighlightPress?: (id: string) => void;
  /** The highlight whose menu is open: pressing it again closes the menu (`onSelectRange(null)`). */
  activeHighlightId?: string | null;
  /** Arranges the blocks; default: one `<p>` per block in order. */
  renderLayout?: (renderBlock: RenderHighlightBlock) => ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

function Piece({ text, segment }: { text: string; segment: TextSegment }) {
  const slice = text.slice(segment.start, segment.end);
  if (segment.emphasis === 'strong') return <strong>{slice}</strong>;
  if (segment.emphasis === 'em') return <em>{slice}</em>;
  return <>{slice}</>;
}

/** Groups consecutive segments with the same key. */
function runs<K>(segments: readonly TextSegment[], key: (s: TextSegment) => K) {
  const out: { key: K; segments: TextSegment[] }[] = [];
  for (const segment of segments) {
    const k = key(segment);
    const last = out[out.length - 1];
    if (last && last.key === k) last.segments.push(segment);
    else out.push({ key: k, segments: [segment] });
  }
  return out;
}

function MatchRuns({
  text,
  segments,
  matches,
}: {
  text: string;
  segments: readonly TextSegment[];
  matches: readonly TextMatch[];
}) {
  return (
    <>
      {runs(segments, (s) => s.match).map((run) => {
        const first = run.segments[0];
        const pieces = run.segments.map((s) => <Piece key={s.start} text={text} segment={s} />);
        if (run.key === undefined || !first) {
          return <Fragment key={first?.start}>{pieces}</Fragment>;
        }
        const match = matches[run.key];
        const current = match?.current === true;
        return (
          <mark
            key={first.start}
            className="qz-search-match"
            data-search-result=""
            data-current={current ? 'true' : undefined}
          >
            {current && match?.start === first.start ? (
              <span {...SKIP} className="qz-visually-hidden">
                현재 결과
              </span>
            ) : null}
            {pieces}
          </mark>
        );
      })}
    </>
  );
}

/**
 * Text with search results only (no highlights, no selection): for quotes shown outside a
 * `HighlightableText`, such as `내 하이라이트` rows, so results look the same everywhere.
 */
export function SearchMatchText({
  text,
  matches = [],
}: {
  text: string;
  matches?: readonly Pick<TextMatch, 'start' | 'end' | 'current'>[];
}) {
  const own = matches.map((m) => ({ ...m, block: '' }));
  return <MatchRuns text={text} segments={textSegments(text, [], own)} matches={own} />;
}

function BlockText({
  block,
  highlights,
  matches,
  readOnly,
}: {
  block: TextBlock;
  highlights: readonly TextHighlight[];
  matches: readonly TextMatch[];
  readOnly: boolean;
}) {
  const own = matches.filter((m) => m.block === block.id);
  const segments = textSegments(block.text, highlights, own, block.emphasis);
  return (
    <>
      {runs(segments, (s) => s.highlight).map((run) => {
        const first = run.segments[0];
        const inner = <MatchRuns text={block.text} segments={run.segments} matches={own} />;
        const h = run.key;
        if (!h || !first) return <Fragment key={first?.start}>{inner}</Fragment>;
        return (
          <mark
            key={first.start}
            className="qz-highlight"
            data-highlight-color={h.color}
            data-highlight-id={h.id}
            data-pressable={readOnly ? undefined : ''}
            tabIndex={-1}
          >
            <span {...SKIP} className="qz-visually-hidden">
              {`하이라이트 시작(${highlightColorLabels[h.color]})`}
            </span>
            {inner}
            <span {...SKIP} className="qz-visually-hidden">
              하이라이트 끝
            </span>
          </mark>
        );
      })}
    </>
  );
}

const selectionKey = (s: HighlightSelection | null) =>
  s ? `${s.block ?? '-'}:${s.start}:${s.end}:${s.block === null ? s.text : ''}` : '';

/**
 * Reading area of the shared highlight tool (design-system §5.2, HILITE-01): draws highlights
 * (`<mark data-highlight-color>` with hidden start/end labels) and search results (`<mark
 * data-search-result>`, drawn above highlights) over the same text, and reports what the reader
 * picks as block offsets. The area is one Tab stop (`role="group"`); ArrowUp/ArrowDown move a
 * roving paragraph focus and Shift+F10, the ContextMenu key or Enter open the menu for that whole
 * paragraph (or for the keyboard selection, if there is one).
 */
export function HighlightableText({
  label,
  blocks,
  highlights = [],
  matches = [],
  scrollToCurrentMatch = true,
  readOnly = false,
  onSelectRange,
  onHighlightPress,
  activeHighlightId,
  renderLayout,
  className,
  ref,
}: HighlightableTextProps) {
  const baseId = useId();
  const regionRef = useRef<HTMLDivElement | null>(null);
  const mergedRef = useMergedRefs(ref, regionRef);
  const [active, setActive] = useState(0);
  const activeIndex = Math.min(active, Math.max(0, blocks.length - 1));
  const blockDomId = (index: number) => `${baseId}-block-${index}`;

  const drawn = useMemo(
    () => new Map(blocks.map((b) => [b.id, drawableHighlights(highlights, b)])),
    [blocks, highlights],
  );

  // Latest callbacks for the document listeners.
  const report = useRef(onSelectRange);
  const press = useRef(onHighlightPress);
  useEffect(() => {
    report.current = onSelectRange;
    press.current = onHighlightPress;
  });

  const pointer = useRef<{
    down: boolean;
    type: SelectionSource;
    x: number;
    y: number;
    /** The press started on the highlight whose menu is open. */
    onOpenMark: boolean;
  }>({ down: false, type: 'mouse', x: 0, y: 0, onOpenMark: false });
  const reported = useRef<HighlightSelection | null>(null);
  const touchTimer = useRef<number | undefined>(undefined);

  const emit = useCallback((selection: HighlightSelection | null) => {
    if (selection === null && reported.current === null) return;
    reported.current = selection;
    report.current?.(selection);
  }, []);

  const pressSelection = useCallback(
    (mark: HTMLElement, source: SelectionSource): HighlightSelection | null => {
      const id = mark.getAttribute('data-highlight-id');
      const blockEl = mark.closest(`[${BLOCK_ATTR}]`);
      const blockId = blockEl?.getAttribute(BLOCK_ATTR);
      const h = blockId ? drawn.get(blockId)?.find((x) => x.id === id) : undefined;
      const block = blocks.find((b) => b.id === blockId);
      if (!h || !block) return null;
      const range = mark.ownerDocument.createRange();
      range.selectNodeContents(mark);
      return selectionOf(
        range,
        block.id,
        h.start,
        h.end,
        block.text.slice(h.start, h.end),
        source === 'keyboard' ? 'keyboard' : 'press',
        mark,
        { highlightId: h.id, keepsDomSelection: false },
      );
    },
    [blocks, drawn],
  );

  useEffect(() => {
    const region = regionRef.current;
    if (!region) return undefined;
    const doc = region.ownerDocument;

    const settleTouch = () => {
      window.clearTimeout(touchTimer.current);
      touchTimer.current = window.setTimeout(() => {
        const selection = readSelection(region, 'touch');
        if (selection) emit(selection);
      }, TOUCH_SELECTION_REST_MS);
    };

    const onPointerEnd = (event: globalThis.PointerEvent) => {
      if (!pointer.current.down) return;
      pointer.current.down = false;
      const touch = pointer.current.type === 'touch';
      const target = event.target instanceof Element ? event.target : null;
      // A press is a pointerup close to where it went down; a cancelled gesture (the browser took
      // it over to scroll) or a swipe is never one.
      const moved = Math.hypot(
        event.clientX - pointer.current.x,
        event.clientY - pointer.current.y,
      );
      const pressable = event.type === 'pointerup' && moved <= PRESS_SLOP_PX;
      const { onOpenMark } = pointer.current;
      // The selection settles after the pointerup (double click selects a word).
      window.setTimeout(() => {
        const selection = readSelection(region, touch ? 'touch' : 'mouse');
        if (selection) {
          // A long-press selection opens once it rests; a mouse selection at once.
          if (touch) settleTouch();
          else emit(selection);
          return;
        }
        // No selection: a click or a tap on a highlight opens its menu (touch parity).
        const mark = target?.closest<HTMLElement>('mark[data-highlight-id][data-pressable]');
        if (pressable && mark && region.contains(mark)) {
          // The open highlight again: its menu stays closed. The press counted as an outside press
          // and may have closed the menu already; this also forgets the pick.
          if (onOpenMark) {
            emit(null);
            return;
          }
          const pressed = pressSelection(mark, 'press');
          if (pressed) {
            press.current?.(pressed.highlightId ?? '');
            emit(pressed);
          }
        }
      }, 0);
    };

    const onSelectionChange = () => {
      if (pointer.current.down && pointer.current.type !== 'touch') return;
      const active = doc.activeElement;
      if (active?.closest('[data-highlight-menu]')) return;
      const now = readSelection(region, pointer.current.type === 'touch' ? 'touch' : 'mouse');
      const last = reported.current;
      if (pointer.current.type === 'touch' && now) {
        if (last && selectionKey(now) !== selectionKey(last)) emit(null);
        settleTouch();
        return;
      }
      if (!last) return;
      // A pressed highlight is not a document selection: only a new selection replaces it.
      if (!now && (last.source === 'press' || last.source === 'keyboard')) return;
      if (!now || selectionKey(now) !== selectionKey(last)) emit(null);
    };

    doc.addEventListener('pointerup', onPointerEnd, true);
    doc.addEventListener('pointercancel', onPointerEnd, true);
    doc.addEventListener('selectionchange', onSelectionChange);
    return () => {
      doc.removeEventListener('pointerup', onPointerEnd, true);
      doc.removeEventListener('pointercancel', onPointerEnd, true);
      doc.removeEventListener('selectionchange', onSelectionChange);
      window.clearTimeout(touchTimer.current);
    };
  }, [emit, pressSelection]);

  // Search: keep the current result in view.
  const currentKey = matches.find((m) => m.current);
  const currentId = currentKey ? `${currentKey.block}:${currentKey.start}` : '';
  useEffect(() => {
    if (!scrollToCurrentMatch || !currentId) return;
    const mark = regionRef.current?.querySelector('mark[data-search-result][data-current="true"]');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    mark?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [currentId, scrollToCurrentMatch]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    const target = event.target as Element;
    const markId = target.closest('mark[data-highlight-id]')?.getAttribute('data-highlight-id');
    pointer.current = {
      down: true,
      type: event.pointerType === 'touch' ? 'touch' : 'mouse',
      x: event.clientX,
      y: event.clientY,
      // Read now: a mouse press closes the menu before the pointer comes up.
      onOpenMark: markId != null && markId === activeHighlightId,
    };
    const blockEl = target.closest(`[${BLOCK_ATTR}]`);
    const index = blocks.findIndex((b) => b.id === blockEl?.getAttribute(BLOCK_ATTR));
    if (index !== -1) setActive(index);
  }

  function openForKeyboard(target: Element) {
    const region = regionRef.current;
    if (!region) return;
    const mark = target.closest<HTMLElement>('mark[data-highlight-id]');
    if (mark && !readOnly) {
      const pressed = pressSelection(mark, 'keyboard');
      if (pressed) {
        onHighlightPress?.(pressed.highlightId ?? '');
        emit(pressed);
        return;
      }
    }
    const fromSelection = readSelection(region, 'keyboard');
    if (fromSelection) {
      emit(fromSelection);
      return;
    }
    const block = blocks[activeIndex];
    const blockEl = region.ownerDocument.getElementById(blockDomId(activeIndex));
    if (!block || !blockEl) return;
    const range = region.ownerDocument.createRange();
    range.selectNodeContents(blockEl);
    emit(
      selectionOf(range, block.id, 0, block.text.length, block.text, 'keyboard', blockEl, {
        keepsDomSelection: false,
      }),
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as Element;
    const onRegion = target === event.currentTarget;
    const onMark = target.matches('mark[data-highlight-id]');
    if (!onRegion && !onMark) return;
    const menuKey =
      event.key === 'ContextMenu' ||
      (event.key === 'F10' && event.shiftKey) ||
      (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey);
    if (menuKey) {
      event.preventDefault();
      openForKeyboard(target);
      return;
    }
    if (!onRegion || blocks.length === 0) return;
    const last = blocks.length - 1;
    const next =
      event.key === 'ArrowDown'
        ? Math.min(last, activeIndex + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, activeIndex - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    regionRef.current?.ownerDocument
      .getElementById(blockDomId(next))
      ?.scrollIntoView({ block: 'nearest' });
  }

  function onCopy(event: ClipboardEvent<HTMLDivElement>) {
    // Native copy leaves out the hidden labels and footnote numbers too.
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    event.clipboardData.setData('text/plain', rangeText(selection.getRangeAt(0)));
    event.preventDefault();
  }

  const renderBlock: RenderHighlightBlock = (id, options = {}) => {
    const index = blocks.findIndex((b) => b.id === id);
    const block = blocks[index];
    if (!block) return null;
    const Tag = options.as ?? 'p';
    return (
      <Tag
        key={block.id}
        id={blockDomId(index)}
        {...{ [BLOCK_ATTR]: block.id }}
        data-active={index === activeIndex ? '' : undefined}
        className={cx('qz-highlightable-block', options.className)}
      >
        {block.prefix ? <span {...SKIP}>{block.prefix}</span> : null}
        <BlockText
          block={block}
          highlights={drawn.get(block.id) ?? []}
          matches={matches}
          readOnly={readOnly}
        />
        {block.suffix ? <span {...SKIP}>{block.suffix}</span> : null}
      </Tag>
    );
  };

  return (
    // The area is one Tab stop with a roving paragraph focus (aria-activedescendant) and its own
    // keyboard menu keys (HILITE-01 "키보드"); `group` is the role the spec names.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={mergedRef}
      role="group"
      aria-label={label}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      aria-activedescendant={blocks.length > 0 ? blockDomId(activeIndex) : undefined}
      data-readonly={readOnly ? '' : undefined}
      className={cx('qz-highlightable', className)}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onCopy={onCopy}
    >
      {renderLayout ? renderLayout(renderBlock) : blocks.map((b) => renderBlock(b.id))}
    </div>
  );
}
