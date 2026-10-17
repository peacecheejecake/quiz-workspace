import { Slot } from 'radix-ui';
import type { HTMLAttributes, Ref } from 'react';
import { cx } from '../internal/cx';

export type SurfacePadding = 'none' | 'sm' | 'md' | 'lg';

interface SurfaceBaseProps extends HTMLAttributes<HTMLDivElement> {
  padding?: SurfacePadding;
  /** Render the single child element with surface styles instead of a `<div>`. */
  asChild?: boolean;
  ref?: Ref<HTMLDivElement>;
}

export interface SurfaceProps extends SurfaceBaseProps {
  /** `default` = opaque surface with border; `muted` = subtle grouped background. */
  tone?: 'default' | 'muted';
}

/** Opaque content surface (cards, reading areas). Glass is reserved for interaction layers. */
export function Surface({
  tone = 'default',
  padding = 'md',
  asChild = false,
  className,
  ...rest
}: SurfaceProps) {
  const Comp = asChild ? Slot.Root : 'div';
  return (
    <Comp
      data-tone={tone}
      data-padding={padding}
      className={cx('qz-surface', className)}
      {...rest}
    />
  );
}

export type GlassSurfaceProps = SurfaceBaseProps;

/**
 * Translucent, blurred surface for floating interaction layers (top bar, panels, popovers).
 * Falls back to the opaque surface when `backdrop-filter` is unsupported or the user prefers
 * reduced transparency (`glass-surface` from @quiz/design-tokens/base.css). Never place it over
 * long-form reading content.
 */
export function GlassSurface({
  padding = 'md',
  asChild = false,
  className,
  ...rest
}: GlassSurfaceProps) {
  const Comp = asChild ? Slot.Root : 'div';
  return (
    <Comp data-padding={padding} className={cx('qz-glass', 'glass-surface', className)} {...rest} />
  );
}
