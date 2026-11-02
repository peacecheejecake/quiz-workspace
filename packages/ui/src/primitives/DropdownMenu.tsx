'use client';

import { DropdownMenu as RadixDropdownMenu } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cx } from '../internal/cx';
import { useLayerStyle } from '../internal/layer';
import { useMergedRefs } from '../internal/merge-refs';
import { useOverscrollGuard } from '../internal/overscroll-guard';

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
