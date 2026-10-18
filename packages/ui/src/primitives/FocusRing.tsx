'use client';

import { Slot } from 'radix-ui';
import type { ReactElement } from 'react';
import { cx } from '../internal/cx';

/**
 * Shared keyboard focus indicator (`:focus-visible` outline in `--color-focus`). Every
 * interactive kit component already applies it; use this class or `<FocusRing>` for custom
 * interactive elements in feature code.
 */
export const focusRingClassName = 'qz-focus-ring';

export interface FocusRingProps {
  /** A single focusable element; the focus ring class is merged into its `className`. */
  children: ReactElement;
  className?: string;
}

export function FocusRing({ children, className }: FocusRingProps) {
  return <Slot.Root className={cx(focusRingClassName, className)}>{children}</Slot.Root>;
}
