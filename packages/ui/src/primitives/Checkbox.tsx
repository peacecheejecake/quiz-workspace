import { Checkbox as RadixCheckbox } from 'radix-ui';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { cx } from '../internal/cx';
import { CheckIcon, MinusIcon } from './icons';

export interface CheckboxProps extends Omit<ComponentProps<typeof RadixCheckbox.Root>, 'children'> {
  /** Visible label (required). */
  label: ReactNode;
  description?: ReactNode;
}

/** Radix checkbox with a label and optional description; supports `checked="indeterminate"`. */
export function Checkbox({ label, description, id, className, ...rest }: CheckboxProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const descriptionId = `${controlId}-description`;
  return (
    <div className={cx('qz-checkbox', className)}>
      <RadixCheckbox.Root
        id={controlId}
        aria-describedby={description ? descriptionId : undefined}
        className="qz-checkbox__box qz-focus-ring"
        {...rest}
      >
        <RadixCheckbox.Indicator className="qz-checkbox__indicator">
          {rest.checked === 'indeterminate' ? (
            <MinusIcon width={14} height={14} strokeWidth={3} />
          ) : (
            <CheckIcon width={14} height={14} strokeWidth={3} />
          )}
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      <div className="qz-checkbox__text">
        <label htmlFor={controlId} className="qz-checkbox__label">
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="qz-field__description">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}
