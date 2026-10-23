import type { HTMLAttributes } from 'react';
import { cx } from '../internal/cx';

export interface ProgressBarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role'> {
  /** Accessible name, e.g. `업로드 진행률`. */
  label: string;
  /** 0–100; `undefined` = indeterminate (no `aria-valuenow`). Out-of-range values are clamped. */
  value?: number;
  /** Spoken value; defaults to `n%` (determinate) or `진행 중` (indeterminate). */
  valueText?: string;
}

/**
 * Accessible progress bar (docs/design-system.md §7). The fill animates between reported values
 * over `--duration-progress`, so coarse server steps (2 → 40 → 60 %) glide instead of jumping;
 * it never invents progress. No transition under `prefers-reduced-motion`.
 */
export function ProgressBar({ label, value, valueText, className, ...rest }: ProgressBarProps) {
  const indeterminate = value === undefined;
  const clamped = indeterminate ? undefined : Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      aria-valuetext={valueText ?? (indeterminate ? '진행 중' : `${clamped}%`)}
      className={cx('qz-progress', className)}
      data-indeterminate={indeterminate ? '' : undefined}
      {...rest}
    >
      <div className="fill" style={indeterminate ? undefined : { width: `${clamped}%` }} />
    </div>
  );
}
