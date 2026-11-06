'use client';

import { Slot } from 'radix-ui';
import type { ButtonHTMLAttributes, Ref } from 'react';
import { cx } from '../internal/cx';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Disables the button, sets `aria-busy` and shows a spinner next to the label. */
  loading?: boolean;
  /**
   * Hides the border for back, header trigger, expand/collapse, 더 보기, list title and the viewer's
   * `다시 풀기` buttons (UX12-CONTROLS, HOME-TOGGLE). Other text buttons keep their boundary.
   */
  borderless?: boolean;
  /** Render the single child (e.g. a link) with button styles instead of a `<button>`. */
  asChild?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  borderless = false,
  asChild = false,
  disabled,
  className,
  children,
  type,
  ...rest
}: ButtonProps) {
  const classes = cx('qz-button', 'qz-focus-ring', className);
  if (asChild) {
    return (
      <Slot.Root
        data-variant={variant}
        data-size={size}
        data-borderless={borderless || undefined}
        className={classes}
        {...rest}
      >
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      type={type ?? 'button'}
      data-variant={variant}
      data-size={size}
      data-borderless={borderless || undefined}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={classes}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}
