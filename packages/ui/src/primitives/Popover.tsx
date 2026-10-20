'use client';

import { Popover as RadixPopover } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cx } from '../internal/cx';
import { useLayerStyle } from '../internal/layer';
import { IconButton } from './IconButton';
import { CloseIcon } from './icons';

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

export interface PopoverContentProps extends ComponentProps<typeof RadixPopover.Content> {
  /** Accessible name of the close button; omit to render no close button. */
  closeLabel?: string;
  children?: ReactNode;
}

/**
 * Glass popover layer (z-index `--z-popover`). Radix handles focus moving into the content,
 * Escape/outside-click dismissal and focus return to the trigger. Give it a name via
 * `aria-label` or `aria-labelledby` when it contains interactive content.
 */
export function PopoverContent({
  closeLabel,
  className,
  children,
  sideOffset = 8,
  style,
  ...rest
}: PopoverContentProps) {
  const layerStyle = useLayerStyle();
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        sideOffset={sideOffset}
        className={cx('qz-popover', 'glass-surface', className)}
        style={{ ...layerStyle, ...style }}
        {...rest}
      >
        {children}
        {closeLabel ? (
          <RadixPopover.Close asChild>
            <IconButton label={closeLabel} icon={<CloseIcon />} size="sm" className="close" />
          </RadixPopover.Close>
        ) : null}
      </RadixPopover.Content>
    </RadixPopover.Portal>
  );
}
