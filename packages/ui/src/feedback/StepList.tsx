'use client';

import type { HTMLAttributes } from 'react';
import { cx } from '../internal/cx';
import { CheckIcon } from '../primitives/icons';
import type { ProgressStep } from './StepProgress';

export interface StepListProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role'> {
  /** Accessible name of the step list. */
  label: string;
  /** The steps in order. */
  steps: readonly ProgressStep[];
  /** Index of the step the person is on. */
  current: number;
  /** Going back: done steps become buttons that call this with their index. */
  onStepSelect?: (index: number) => void;
  /** Accessible name of a done step's button, e.g. `옵션 단계로 돌아가기`. */
  stepActionLabel?: (step: ProgressStep) => string;
  /** Done steps stay buttons but cannot be pressed (the form is working). */
  disabled?: boolean;
}

/**
 * The steps of a form the person moves through (docs/design-system.md §7): `StepProgress`'s step
 * list without its bar, because nothing is running here and a `progressbar` would say otherwise.
 * Same states, each also said in text: done = check icon, current = bold number with
 * `aria-current="step"`, pending = number. Only done steps are buttons; later ones are reached
 * through the form's own validation.
 */
export function StepList({
  label,
  steps,
  current,
  onStepSelect,
  stepActionLabel,
  disabled = false,
  className,
  ...rest
}: StepListProps) {
  return (
    <div className={cx('qz-step-progress', 'qz-step-list', className)} {...rest}>
      <ol className="steps" aria-label={label}>
        {steps.map((step, i) => {
          const state = i < current ? 'done' : i === current ? 'current' : 'pending';
          const content = (
            <>
              <span className="marker" aria-hidden="true">
                {state === 'done' ? (
                  <CheckIcon width={12} height={12} />
                ) : (
                  <span className="number">{i + 1}</span>
                )}
              </span>
              <span className="label">{step.label}</span>
            </>
          );
          return (
            <li
              key={step.id}
              className="step"
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              {state === 'done' && onStepSelect ? (
                <button
                  type="button"
                  className="action"
                  aria-label={stepActionLabel?.(step)}
                  disabled={disabled}
                  onClick={() => onStepSelect(i)}
                >
                  {content}
                  <span className="qz-visually-hidden">완료</span>
                </button>
              ) : (
                <>
                  {content}
                  <span className="qz-visually-hidden">
                    {state === 'done' ? '완료' : state === 'current' ? '현재 단계' : '대기'}
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
