'use client';

import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { useLayerStyle } from '../internal/layer';

/** Hover delay (ms) before a tooltip opens; keyboard focus opens it immediately. */
export const TOOLTIP_DELAY_MS = 300;
/**
 * Longer hover delay (ms) for descriptions of choices (RadioGroup `optionDescriptions="tooltip"`):
 * moving the pointer across a list of options must not flash every description.
 */
export const TOOLTIP_DESCRIPTION_DELAY_MS = 700;

export interface TooltipProps extends Pick<
  ComponentProps<typeof RadixTooltip.Root>,
  'open' | 'defaultOpen' | 'onOpenChange'
> {
  /** Supplementary text. Never put essential information or interactive content here. */
  content: ReactNode;
  /** A single focusable trigger; the tooltip opens on hover and on keyboard focus. */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Hover delay in ms (default `TOOLTIP_DELAY_MS`). Keyboard focus always opens immediately. */
  delayDuration?: number;
}

/**
 * Hover/focus hint built on Radix Tooltip (Escape dismisses, text is exposed as the trigger's
 * description). Each tooltip carries its own provider so it works without app-level setup.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  delayDuration = TOOLTIP_DELAY_MS,
  ...rootProps
}: TooltipProps) {
  const layerStyle = useLayerStyle();
  return (
    <RadixTooltip.Provider delayDuration={delayDuration}>
      <RadixTooltip.Root {...rootProps}>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            sideOffset={6}
            className="qz-tooltip"
            style={layerStyle}
          >
            {content}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
