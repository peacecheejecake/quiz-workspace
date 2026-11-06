'use client';

import { DropdownMenu as RadixDropdownMenu } from 'radix-ui';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useLayerStyle } from '../internal/layer';
import { useOverscrollGuard } from '../internal/overscroll-guard';
import { CheckIcon, TrashIcon } from '../primitives/icons';
import {
  HIGHLIGHT_COLORS,
  colorAction,
  exactHighlight,
  highlightColorLabels,
  overlappingHighlights,
  type HighlightAction,
  type HighlightColor,
  type HighlightSelection,
  type TextHighlight,
} from './model';

export const HIGHLIGHT_MENU_TEXT = {
  label: '하이라이트',
  remove: '하이라이트 지우기',
  oneBlock: '한 문단 안에서 고르세요',
} as const;

export interface HighlightMenuProps {
  /** What the reader picked (from `HighlightableText`); the menu is open while it is set. */
  selection: HighlightSelection | null;
  /** The highlights of the same area (to merge, check the current color and offer removal). */
  highlights: readonly TextHighlight[];
  /** Called with the change to make; the menu closes afterwards. */
  onAction?: (action: HighlightAction) => void;
  /** The menu closed (Escape, outside press, after an action): clear `selection`. */
  onClose: () => void;
  /** No items to offer: the menu stays closed (no screen uses this today, HILITE-01). */
  readOnly?: boolean;
  /** Focus goes back here on Escape and after an action (the `HighlightableText` area). */
  returnFocusTo?: RefObject<HTMLElement | null>;
}

/** The color and the underline shape of its marks (solid, double, dotted): never color alone. */
function Swatch({ color }: { color: HighlightColor }) {
  return <span className="swatch" data-highlight-color={color} aria-hidden="true" />;
}

/**
 * The menu next to a selection in a `HighlightableText` (design-system §5.2): Radix DropdownMenu
 * (`role="menu"` "하이라이트") anchored to the selection's box — above it, below when there is no
 * room, and below the end of a touch selection so it does not cover the OS selection menu. One
 * compact row of icon-only items, each named by `aria-label`: the three colors (`menuitemradio`,
 * checked when the selection is exactly one highlight of that color, marked by a check) · `하이라이트
 * 지우기` (a trash icon, when the selection touches a highlight). Left/Right move along the row.
 * There is no `복사`: the OS menu and Ctrl/Cmd+C copy (2026-11-07). The selection stays
 * painted while the menu is open. Escape closes only the menu, keeps the selection and returns
 * focus to the area.
 */
export function HighlightMenu({
  selection,
  highlights,
  onAction,
  onClose,
  readOnly = false,
  returnFocusTo,
}: HighlightMenuProps) {
  const reasonId = useId();
  const layerStyle = useLayerStyle();
  const guardOverscroll = useOverscrollGuard<HTMLDivElement>();
  const [scrolled, setScrolled] = useState(0);
  const closing = useRef<'escape' | 'outside' | 'action' | null>(null);
  const last = useRef<HighlightSelection | null>(null);
  const open = selection !== null && !readOnly;
  // Measured while rendering so the anchor is in place when the menu mounts; re-measured after a
  // scroll (the popper re-reads the anchor every frame while open).
  const rect = useMemo(
    () => (selection && scrolled >= 0 ? selection.getAnchorRect() : null),
    [selection, scrolled],
  );

  useEffect(() => {
    if (!selection) return undefined;
    last.current = selection;
    closing.current = null;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setScrolled((n) => n + 1));
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [selection]);

  const range =
    selection && selection.block !== null
      ? { block: selection.block, start: selection.start, end: selection.end }
      : null;
  const exact = range ? exactHighlight(highlights, range) : undefined;
  const touching = range ? overlappingHighlights(highlights, range) : [];
  const crosses = selection !== null && selection.block === null;
  const touch = selection?.source === 'touch';

  function act(action: HighlightAction | null) {
    closing.current = 'action';
    if (action) onAction?.(action);
    onClose();
  }

  const anchorStyle: CSSProperties = {
    position: 'fixed',
    left: rect?.left ?? 0,
    top: rect?.top ?? 0,
    width: rect?.width ?? 0,
    height: rect?.height ?? 0,
    pointerEvents: 'none',
    visibility: 'hidden',
  };

  return (
    <RadixDropdownMenu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {typeof document === 'undefined'
        ? null
        : createPortal(
            <RadixDropdownMenu.Trigger asChild>
              <span aria-hidden="true" tabIndex={-1} style={anchorStyle} data-highlight-anchor="" />
            </RadixDropdownMenu.Trigger>,
            document.body,
          )}
      <RadixDropdownMenu.Portal>
        <RadixDropdownMenu.Content
          ref={guardOverscroll}
          aria-label={HIGHLIGHT_MENU_TEXT.label}
          aria-labelledby={undefined}
          side={touch ? 'bottom' : 'top'}
          align={touch ? 'end' : 'center'}
          sideOffset={8}
          collisionPadding={16}
          updatePositionStrategy="always"
          data-highlight-menu=""
          data-touch={touch ? '' : undefined}
          className="qz-menu glass-surface qz-highlight-menu"
          style={layerStyle}
          onEscapeKeyDown={() => {
            closing.current = 'escape';
          }}
          onInteractOutside={() => {
            closing.current = 'outside';
          }}
          onPointerDownOutside={() => {
            // The kept selection goes with the menu: a press on the selected text then starts a
            // new selection instead of dragging the old one.
            window.getSelection()?.removeAllRanges();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const reason = closing.current;
            closing.current = null;
            if (reason === 'outside') return;
            returnFocusTo?.current?.focus({ preventScroll: true });
            if (reason === 'escape') last.current?.restore();
            else window.getSelection()?.removeAllRanges();
          }}
          onKeyDown={(event) => {
            // The items sit in a row: Left/Right move along it (Radix's roving focus is vertical).
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                '[role^="menuitem"]:not([data-disabled])',
              ),
            ];
            if (items.length === 0) return;
            const at = items.indexOf(document.activeElement as HTMLElement);
            const step = event.key === 'ArrowRight' ? 1 : -1;
            event.preventDefault();
            items[(at + step + items.length) % items.length]?.focus();
          }}
          onFocus={() => {
            // WebKit drops the document selection on every focus move, so the menu (which takes
            // focus, and hands it from item to item) puts it back to keep it painted.
            // `HighlightableText` ignores these changes while focus is in the menu.
            if (!closing.current) selection?.restore();
          }}
        >
          <RadixDropdownMenu.RadioGroup value={exact?.color ?? ''}>
            {HIGHLIGHT_COLORS.map((color) => (
              <RadixDropdownMenu.RadioItem
                key={color}
                value={color}
                disabled={crosses}
                aria-label={highlightColorLabels[color]}
                textValue={highlightColorLabels[color]}
                aria-describedby={crosses ? reasonId : undefined}
                title={highlightColorLabels[color]}
                className="item"
                data-color-item={color}
                onSelect={() => {
                  if (range) act(colorAction(highlights, range, color));
                }}
              >
                <Swatch color={color} />
                <RadixDropdownMenu.ItemIndicator className="check">
                  <CheckIcon width={16} height={16} aria-hidden="true" />
                </RadixDropdownMenu.ItemIndicator>
              </RadixDropdownMenu.RadioItem>
            ))}
          </RadixDropdownMenu.RadioGroup>
          {crosses ? (
            <p id={reasonId} className="qz-visually-hidden">
              {HIGHLIGHT_MENU_TEXT.oneBlock}
            </p>
          ) : null}
          {touching.length > 0 ? (
            <>
              <RadixDropdownMenu.Separator className="separator" />
              <RadixDropdownMenu.Item
                className="item"
                aria-label={HIGHLIGHT_MENU_TEXT.remove}
                textValue={HIGHLIGHT_MENU_TEXT.remove}
                title={HIGHLIGHT_MENU_TEXT.remove}
                data-remove-item=""
                onSelect={() => act({ type: 'remove', ids: touching.map((h) => h.id) })}
              >
                <TrashIcon width={18} height={18} aria-hidden="true" />
              </RadixDropdownMenu.Item>
            </>
          ) : null}
        </RadixDropdownMenu.Content>
      </RadixDropdownMenu.Portal>
    </RadixDropdownMenu.Root>
  );
}
