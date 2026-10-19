'use client';

import { Select as RadixSelect } from 'radix-ui';
import type { ReactNode } from 'react';
import { cx } from '../internal/cx';
import { useLayerStyle } from '../internal/layer';
import { FieldFrame, useFieldIds, type FieldOwnProps } from './Field';
import { CheckIcon, ChevronDownIcon } from './icons';

export interface SelectOption {
  /** Non-empty value (Radix reserves the empty string for "no selection"). */
  value: string;
  label: ReactNode;
  /** Plain-text label for typeahead when `label` is not a string. */
  textValue?: string;
  disabled?: boolean;
}

export interface SelectProps extends FieldOwnProps {
  options: readonly SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Shown while nothing is selected. */
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  /** Form field name (Radix renders a hidden native select for form submission). */
  name?: string;
  id?: string;
  /** Class for the field wrapper (label + control + messages). */
  fieldClassName?: string;
  className?: string;
  'aria-describedby'?: string;
}

/**
 * Labelled single-choice picker on Radix Select: the trigger is a `combobox` named by the visible
 * label, the popup a `listbox` of `option`s (Arrow keys, typeahead, Escape returns focus). Use it
 * for filters and form fields with a short, known list of choices.
 */
export function Select({
  label,
  hideLabel,
  description,
  error,
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  disabled,
  required,
  name,
  id,
  fieldClassName,
  className,
  'aria-describedby': ariaDescribedBy,
}: SelectProps) {
  const ids = useFieldIds(id, description, error, ariaDescribedBy);
  const labelId = `${ids.id}-label`;
  const layerStyle = useLayerStyle();
  return (
    <FieldFrame
      ids={ids}
      labelId={labelId}
      label={label}
      hideLabel={hideLabel}
      description={description}
      error={error}
      className={fieldClassName}
    >
      <RadixSelect.Root
        {...(value !== undefined ? { value } : {})}
        {...(defaultValue !== undefined ? { defaultValue } : {})}
        {...(onValueChange ? { onValueChange } : {})}
        {...(disabled !== undefined ? { disabled } : {})}
        {...(required !== undefined ? { required } : {})}
        {...(name !== undefined ? { name } : {})}
      >
        <RadixSelect.Trigger
          id={ids.id}
          aria-labelledby={labelId}
          aria-describedby={ids.describedBy}
          aria-invalid={ids.hasError || undefined}
          aria-errormessage={ids.hasError ? ids.errorId : undefined}
          className={cx('qz-control', 'qz-select', 'qz-focus-ring', className)}
        >
          <span className="value">
            <RadixSelect.Value placeholder={placeholder} />
          </span>
          <RadixSelect.Icon className="icon">
            <ChevronDownIcon width={18} height={18} />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            position="popper"
            sideOffset={4}
            className="qz-select-content glass-surface"
            style={layerStyle}
          >
            <RadixSelect.Viewport className="viewport">
              {options.map((option) => (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  className="item"
                  {...(option.disabled ? { disabled: true } : {})}
                  {...(option.textValue ? { textValue: option.textValue } : {})}
                >
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator className="indicator">
                    <CheckIcon width={16} height={16} />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </FieldFrame>
  );
}
