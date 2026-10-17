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
  /** Render the single child (e.g. a link) with button styles instead of a `<button>`. */
  asChild?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
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
      <Slot.Root data-variant={variant} data-size={size} className={classes} {...rest}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      type={type ?? 'button'}
      data-variant={variant}
      data-size={size}
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
