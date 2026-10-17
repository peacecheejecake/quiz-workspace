import type { CSSProperties, HTMLAttributes } from 'react';
import { cx } from '../internal/cx';

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  /** CSS length, e.g. `'100%'` or `'12rem'`. */
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  shape?: 'text' | 'rect' | 'circle';
}

/**
 * Decorative loading placeholder (hidden from assistive technology). Mark the loading region
 * with `aria-busy="true"` and provide a text status for screen readers.
 */
export function Skeleton({
  width,
  height,
  shape = 'text',
  className,
  style,
  ...rest
}: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      data-shape={shape}
      className={cx('qz-skeleton', className)}
      style={{ width, height, ...style }}
      {...rest}
    />
  );
}
