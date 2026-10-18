'use client';

import type { Ref, TextareaHTMLAttributes } from 'react';
import { cx } from '../internal/cx';
import { FieldFrame, useFieldIds, type FieldOwnProps } from './Field';

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'children'>, FieldOwnProps {
  fieldClassName?: string;
  ref?: Ref<HTMLTextAreaElement>;
}

/** Labelled multi-line text field; vertically resizable. */
export function Textarea({
  label,
  hideLabel,
  description,
  error,
  id,
  className,
  fieldClassName,
  rows,
  'aria-describedby': ariaDescribedBy,
  ...rest
}: TextareaProps) {
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
      <textarea
        id={ids.id}
        rows={rows ?? 4}
        aria-describedby={ids.describedBy}
        aria-invalid={ids.hasError || undefined}
        aria-errormessage={ids.hasError ? ids.errorId : undefined}
        className={cx('qz-control', 'qz-control--multiline', 'qz-focus-ring', className)}
        {...rest}
      />
    </FieldFrame>
  );
}
