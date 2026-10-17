'use client';

import { DropdownMenu as RadixDropdownMenu } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cx } from '../internal/cx';
import { useLayerStyle } from '../internal/layer';

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
  ...rest
}: DropdownMenuContentProps) {
  const layerStyle = useLayerStyle();
  return (
    <RadixDropdownMenu.Portal>
      <RadixDropdownMenu.Content
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
  return (
    <RadixDropdownMenu.Item data-tone={tone} className={cx('qz-menu__item', className)} {...rest} />
  );
}

export function DropdownMenuSeparator({
  className,
  ...rest
}: ComponentProps<typeof RadixDropdownMenu.Separator>) {
  return <RadixDropdownMenu.Separator className={cx('qz-menu__separator', className)} {...rest} />;
}
