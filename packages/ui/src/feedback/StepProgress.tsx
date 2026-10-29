import type { HTMLAttributes } from 'react';
import { cx } from '../internal/cx';
import { CheckIcon } from '../primitives/icons';

export interface ProgressStep {
  /** Stable key of the step. */
  readonly id: string;
  /** Visible name, e.g. `업로드`. */
  readonly label: string;
}

export interface StepProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role'> {
  /** Accessible name of the progress bar, e.g. `가져오기 진행률`. */
  label: string;
  /** The steps in order (at least one). */
  steps: readonly ProgressStep[];
  /** Index of the running step; `steps.length` (or more) = every step done. */
  current: number;
  /** 0–100 progress of the current step; `undefined` = indeterminate. Clamped. */
  value?: number;
  /** Spoken text of the current step (e.g. `PDF 분석 중`); defaults to its label. */
  currentText?: string;
  /** Accessible name of the step list. */
  stepsLabel?: string;
}

type StepState = 'done' | 'current' | 'pending';

const STATE_TEXT: Readonly<Record<StepState, string>> = {
  done: '완료',
  current: '진행 중',
  pending: '대기',
};

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Progress of a job that runs through ordered steps (docs/design-system.md §7, UX6-PROGRESS): the
 * step list (done = check icon, current = bold number with `aria-current="step"`, pending =
 * number; each also says its state in text) above one bar split into a segment per step. Done
 * segments are full, the current one fills with the step's own progress and pending ones are
 * empty, so the bar never goes backwards when a step ends and the next starts at 0 %. Fills glide
 * over `--duration-progress` (none under `prefers-reduced-motion`).
 */
export function StepProgress({
  label,
  steps,
  current,
  value,
  currentText,
  stepsLabel = '진행 단계',
  className,
  ...rest
}: StepProgressProps) {
  const count = steps.length;
  const finished = current >= count;
  const index = Math.max(0, Math.min(current, count));
  const indeterminate = !finished && value === undefined;
  const fraction = finished || value === undefined ? 0 : clampPercent(value) / 100;
  const overall = count === 0 ? 100 : Math.round(((index + fraction) / count) * 100);
  const step = steps[index];
  const valueText = finished
    ? `${count}/${count}단계 완료`
    : `${index + 1}/${count}단계: ${currentText ?? step?.label ?? ''}${
        value === undefined ? '' : `, ${Math.round(clampPercent(value))}%`
      }`;
  const stateOf = (i: number): StepState =>
    i < index || finished ? 'done' : i === index ? 'current' : 'pending';

  return (
    <div className={cx('qz-step-progress', className)} {...rest}>
      <ol className="steps" aria-label={stepsLabel}>
        {steps.map((s, i) => {
          const state = stateOf(i);
          return (
            <li
              key={s.id}
              className="step"
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className="marker" aria-hidden="true">
                {state === 'done' ? <CheckIcon width={12} height={12} /> : i + 1}
              </span>
              <span className="label">{s.label}</span>
              <span className="qz-visually-hidden">{STATE_TEXT[state]}</span>
            </li>
          );
        })}
      </ol>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : overall}
        aria-valuetext={valueText}
        className="track"
      >
        {steps.map((s, i) => {
          const state = stateOf(i);
          const scale = state === 'done' ? 1 : state === 'current' ? fraction : 0;
          return (
            <div
              key={s.id}
              className="segment"
              data-state={state}
              data-indeterminate={state === 'current' && indeterminate ? '' : undefined}
            >
              <div className="fill" style={{ transform: `scaleX(${scale})` }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
