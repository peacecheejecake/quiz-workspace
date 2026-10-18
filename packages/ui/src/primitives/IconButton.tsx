'use client';

import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from '../internal/cx';
import type { ButtonSize, ButtonVariant } from './Button';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'aria-labelledby' | 'children'
> {
  /** Accessible name (required: an icon alone has none). Also used as the native tooltip. */
  label: string;
  /** Decorative icon; it is hidden from assistive technology. */
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
}

/** Square icon-only button with a 40px (md) / 32px (sm) target. */
export function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'md',
  className,
  type,
  title,
  ...rest
}: IconButtonProps) {
  if (typeof label !== 'string' || label.trim() === '') {
    throw new Error('IconButton requires a non-empty `label` for its accessible name.');
  }
  return (
    <button
      type={type ?? 'button'}
      aria-label={label}
      title={title ?? label}
      data-variant={variant}
      data-size={size}
      className={cx('qz-icon-button', 'qz-focus-ring', className)}
      {...rest}
    >
      <span className="qz-icon-button__icon" aria-hidden="true">
        {icon}
      </span>
    </button>
  );
}
