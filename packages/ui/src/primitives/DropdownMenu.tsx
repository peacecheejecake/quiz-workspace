'use client';

import { DropdownMenu as RadixDropdownMenu } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cx } from '../internal/cx';
import { useLayerStyle } from '../internal/layer';
import { useMergedRefs } from '../internal/merge-refs';
import { useOverscrollGuard } from '../internal/overscroll-guard';
import { CheckIcon, ChevronRightIcon } from './icons';

export const DropdownMenu = RadixDropdownMenu.Root;
export const DropdownMenuTrigger = RadixDropdownMenu.Trigger;

export type DropdownMenuContentProps = ComponentProps<typeof RadixDropdownMenu.Content>;
export type DropdownMenuItemProps = ComponentProps<typeof RadixDropdownMenu.Item> & {
  /** Destructive action: adds a danger accent; the label must still say what it does. */
  tone?: 'default' | 'danger';
};

/**
 * Action menu on Radix DropdownMenu (role="menu"; Arrow keys, typeahead, Escape returns focus to
 * the trigger). Use it for per-item actions such as "더보기".
 */
export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'end',
  style,
  ref,
  ...rest
}: DropdownMenuContentProps) {
  const layerStyle = useLayerStyle();
  // Scrolling a list inside the popper never scrolls the page under it (UX9-SCROLL).
  const guardOverscroll = useOverscrollGuard<HTMLDivElement>();
  const contentRef = useMergedRefs(ref, guardOverscroll);
  return (
    <RadixDropdownMenu.Portal>
      <RadixDropdownMenu.Content
        ref={contentRef}
        sideOffset={sideOffset}
        align={align}
        className={cx('qz-menu', 'glass-surface', className)}
        style={{ ...layerStyle, ...style }}
        {...rest}
      />
    </RadixDropdownMenu.Portal>
  );
}

export function DropdownMenuItem({ className, tone = 'default', ...rest }: DropdownMenuItemProps) {
  return <RadixDropdownMenu.Item data-tone={tone} className={cx('item', className)} {...rest} />;
}

export type DropdownMenuGroupProps = ComponentProps<typeof RadixDropdownMenu.Group>;

/**
 * Group of related items (role="group"). Pass `aria-labelledby` pointing at a
 * `DropdownMenuLabel` inside it so the group is named for screen readers.
 */
export function DropdownMenuGroup({ className, ...rest }: DropdownMenuGroupProps) {
  return <RadixDropdownMenu.Group className={cx('group', className)} {...rest} />;
}

/** Non-interactive heading of a menu section (not focusable, skipped by the arrow keys). */
export function DropdownMenuLabel({
  className,
  ...rest
}: ComponentProps<typeof RadixDropdownMenu.Label>) {
  return <RadixDropdownMenu.Label className={cx('label', className)} {...rest} />;
}

export function DropdownMenuSeparator({
  className,
  ...rest
}: ComponentProps<typeof RadixDropdownMenu.Separator>) {
  return <RadixDropdownMenu.Separator className={cx('separator', className)} {...rest} />;
}

export const DropdownMenuSub = RadixDropdownMenu.Sub;

/**
 * Item that opens a submenu (ArrowRight / Enter / click / hover); shows a trailing chevron. The
 * submenu stays open when the pointer leaves the trigger and closes when another item of the menu
 * takes the pointer or focus: Radix's "moving towards the submenu" guess reads the pointer's last
 * direction, which is wrong when the submenu flipped to the other side (a menu at the screen edge).
 */
export function DropdownMenuSubTrigger({
  className,
  children,
  onPointerLeave,
  onKeyDown,
  ...rest
}: ComponentProps<typeof RadixDropdownMenu.SubTrigger>) {
  return (
    <RadixDropdownMenu.SubTrigger
      className={cx('item', className)}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
        // Only an open submenu is kept (a passing pointer still cancels a pending open).
        if (event.currentTarget.getAttribute('data-state') === 'open') event.preventDefault();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        // ArrowDown / ArrowUp on the trigger of an open submenu (focus has not moved into it yet,
        // e.g. right after ArrowRight) go into the submenu instead of moving along the parent menu,
        // which would close it.
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const trigger = event.currentTarget;
        if (trigger.getAttribute('data-state') !== 'open') return;
        event.preventDefault();
        const id = trigger.getAttribute('aria-controls');
        const content = id ? trigger.ownerDocument.getElementById(id) : null;
        const items = [
          ...(content?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([data-disabled])') ??
            []),
        ];
        (event.key === 'ArrowDown' ? items[0] : items[items.length - 1])?.focus();
      }}
      {...rest}
    >
      <span className="text">{children}</span>
      <ChevronRightIcon width={16} height={16} aria-hidden="true" />
    </RadixDropdownMenu.SubTrigger>
  );
}

/** The submenu of a `DropdownMenuSubTrigger` (same surface as `DropdownMenuContent`). */
export function DropdownMenuSubContent({
  className,
  sideOffset = 4,
  style,
  ref,
  ...rest
}: ComponentProps<typeof RadixDropdownMenu.SubContent>) {
  const layerStyle = useLayerStyle();
  const guardOverscroll = useOverscrollGuard<HTMLDivElement>();
  const contentRef = useMergedRefs(ref, guardOverscroll);
  return (
    <RadixDropdownMenu.Portal>
      <RadixDropdownMenu.SubContent
        ref={contentRef}
        sideOffset={sideOffset}
        className={cx('qz-menu', 'glass-surface', className)}
        style={{ ...layerStyle, ...style }}
        {...rest}
      />
    </RadixDropdownMenu.Portal>
  );
}

/** One-of-many items (`menuitemradio` with `aria-checked`); the chosen one shows a check. */
export function DropdownMenuRadioGroup({
  className,
  ...rest
}: ComponentProps<typeof RadixDropdownMenu.RadioGroup>) {
  return <RadixDropdownMenu.RadioGroup className={cx('group', className)} {...rest} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...rest
}: ComponentProps<typeof RadixDropdownMenu.RadioItem>) {
  return (
    <RadixDropdownMenu.RadioItem className={cx('item', className)} {...rest}>
      <span className="text">{children}</span>
      <RadixDropdownMenu.ItemIndicator className="check">
        <CheckIcon width={16} height={16} aria-hidden="true" />
      </RadixDropdownMenu.ItemIndicator>
    </RadixDropdownMenu.RadioItem>
  );
}
