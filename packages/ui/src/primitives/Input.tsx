import type { InputHTMLAttributes, Ref } from 'react';
import { cx } from '../internal/cx';
import { FieldFrame, useFieldIds, type FieldOwnProps } from './Field';

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'children'>, FieldOwnProps {
  /** Class for the field wrapper (label + control + messages). */
  fieldClassName?: string;
  ref?: Ref<HTMLInputElement>;
}

/** Labelled single-line text field with description and error wiring. */
export function Input({
  label,
  hideLabel,
  description,
  error,
  id,
  className,
  fieldClassName,
  type,
  'aria-describedby': ariaDescribedBy,
  ...rest
}: InputProps) {
  const ids = useFieldIds(id, description, error, ariaDescribedBy);
  return (
    <FieldFrame
      ids={ids}
      label={label}
      hideLabel={hideLabel}
      description={description}
      error={error}
      className={fieldClassName}
    >
      <input
        id={ids.id}
        type={type ?? 'text'}
        aria-describedby={ids.describedBy}
        aria-invalid={ids.hasError || undefined}
        aria-errormessage={ids.hasError ? ids.errorId : undefined}
        className={cx('qz-control', 'qz-focus-ring', className)}
        {...rest}
      />
    </FieldFrame>
  );
}
