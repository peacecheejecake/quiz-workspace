'use client';

import { Popover as RadixPopover } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cx } from '../internal/cx';
import { useLayerStyle } from '../internal/layer';
import { useMergedRefs } from '../internal/merge-refs';
import { useOverscrollGuard } from '../internal/overscroll-guard';
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
  ref,
  ...rest
}: PopoverContentProps) {
  const layerStyle = useLayerStyle();
  // Scrolling a list inside the popper never scrolls the page under it (UX9-SCROLL).
  const guardOverscroll = useOverscrollGuard<HTMLDivElement>();
  const contentRef = useMergedRefs(ref, guardOverscroll);
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        ref={contentRef}
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
