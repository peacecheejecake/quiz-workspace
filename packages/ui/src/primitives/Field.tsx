'use client';

import { useId, type ReactNode } from 'react';
import { cx } from '../internal/cx';
import { AlertIcon } from './icons';

export interface FieldOwnProps {
  /** Visible label (required: every field needs an accessible name). */
  label: ReactNode;
  /** Visually hide the label while keeping it as the accessible name. */
  hideLabel?: boolean;
  /** Helper text linked via `aria-describedby`. */
  description?: ReactNode;
  /** Error message. Sets `aria-invalid` and is shown with an icon, not by color alone. */
  error?: ReactNode;
}

export interface FieldIds {
  id: string;
  descriptionId: string;
  errorId: string;
  hasError: boolean;
  /** Value for the control's `aria-describedby`. */
  describedBy: string | undefined;
}

export function useFieldIds(
  idProp: string | undefined,
  description: ReactNode,
  error: ReactNode,
  ariaDescribedBy: string | undefined,
): FieldIds {
  const generated = useId();
  const id = idProp ?? generated;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const hasError = error !== undefined && error !== null && error !== false;
  const describedBy =
    [ariaDescribedBy, description ? descriptionId : null, hasError ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined;
  return { id, descriptionId, errorId, hasError, describedBy };
}

export function FieldFrame({
  ids,
  label,
  hideLabel,
  description,
  error,
  className,
  labelId,
  children,
}: FieldOwnProps & {
  ids: FieldIds;
  className?: string | undefined;
  /** Id for the label, for controls named through `aria-labelledby` (e.g. Select). */
  labelId?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={cx('qz-field', className)} data-invalid={ids.hasError || undefined}>
      <label
        id={labelId}
        htmlFor={ids.id}
        className={cx('qz-field__label', hideLabel && 'qz-visually-hidden')}
      >
        {label}
      </label>
      {children}
      {description ? (
        <p id={ids.descriptionId} className="qz-field__description">
          {description}
        </p>
      ) : null}
      {ids.hasError ? (
        <p id={ids.errorId} className="qz-field__error">
          <AlertIcon width={16} height={16} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
