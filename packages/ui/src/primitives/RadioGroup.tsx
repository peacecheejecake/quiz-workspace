'use client';

import { RadioGroup as RadixRadioGroup } from 'radix-ui';
import { useId, type ReactNode } from 'react';
import { cx } from '../internal/cx';
import { AlertIcon } from './icons';

export interface RadioOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  /** Group label (required): names the `radiogroup`. */
  label: ReactNode;
  hideLabel?: boolean;
  description?: ReactNode;
  error?: ReactNode;
  options: readonly RadioOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}

/**
 * Labelled radio group on Radix RadioGroup (role="radiogroup"; one tab stop, Arrow keys move and
 * select). Each option is a `radio` named by its visible label.
 */
export function RadioGroup({
  label,
  hideLabel,
  description,
  error,
  options,
  value,
  defaultValue,
  onValueChange,
  disabled,
  required,
  name,
  orientation = 'horizontal',
  className,
}: RadioGroupProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const hasError = error !== undefined && error !== null && error !== false;
  const describedBy =
    [description ? descriptionId : null, hasError ? errorId : null].filter(Boolean).join(' ') ||
    undefined;
  return (
    <div className={cx('qz-field', className)} data-invalid={hasError || undefined}>
      <span id={labelId} className={cx('qz-field__label', hideLabel && 'qz-visually-hidden')}>
        {label}
      </span>
      <RadixRadioGroup.Root
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-invalid={hasError || undefined}
        orientation={orientation}
        className="qz-radio-group"
        {...(value !== undefined ? { value } : {})}
        {...(defaultValue !== undefined ? { defaultValue } : {})}
        {...(onValueChange ? { onValueChange } : {})}
        {...(disabled !== undefined ? { disabled } : {})}
        {...(required !== undefined ? { required } : {})}
        {...(name !== undefined ? { name } : {})}
      >
        {options.map((option) => {
          const itemId = `${id}-${option.value}`;
          return (
            <div key={option.value} className="qz-radio">
              <RadixRadioGroup.Item
                id={itemId}
                value={option.value}
                className="qz-radio__circle qz-focus-ring"
                aria-describedby={option.description ? `${itemId}-description` : undefined}
                {...(option.disabled ? { disabled: true } : {})}
              >
                <RadixRadioGroup.Indicator className="qz-radio__indicator" />
              </RadixRadioGroup.Item>
              <div className="qz-checkbox__text">
                <label htmlFor={itemId} className="qz-checkbox__label">
                  {option.label}
                </label>
                {option.description ? (
                  <p id={`${itemId}-description`} className="qz-field__description">
                    {option.description}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </RadixRadioGroup.Root>
      {description ? (
        <p id={descriptionId} className="qz-field__description">
          {description}
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} className="qz-field__error">
          <AlertIcon width={16} height={16} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
