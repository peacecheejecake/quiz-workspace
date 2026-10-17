import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { useLayerStyle } from '../internal/layer';

export interface TooltipProps extends Pick<
  ComponentProps<typeof RadixTooltip.Root>,
  'open' | 'defaultOpen' | 'onOpenChange' | 'delayDuration'
> {
  /** Supplementary text. Never put essential information or interactive content here. */
  content: ReactNode;
  /** A single focusable trigger; the tooltip opens on hover and on keyboard focus. */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * Hover/focus hint built on Radix Tooltip (Escape dismisses, text is exposed as the trigger's
 * description). Each tooltip carries its own provider so it works without app-level setup.
 */
export function Tooltip({ content, children, side = 'top', ...rootProps }: TooltipProps) {
  const layerStyle = useLayerStyle();
  return (
    <RadixTooltip.Provider delayDuration={300}>
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
