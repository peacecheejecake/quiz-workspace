import type { HTMLAttributes } from 'react';
import { cx } from '../internal/cx';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

/**
 * Small status label. The text carries the meaning; tones other than neutral/accent add a
 * colored dot as a secondary cue (never color alone).
 */
export function Badge({ tone = 'neutral', className, children, ...rest }: BadgeProps) {
  const hasDot = tone === 'success' || tone === 'warning' || tone === 'danger';
  return (
    <span data-tone={tone} className={cx('qz-badge', className)} {...rest}>
      {hasDot ? <span className="dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
