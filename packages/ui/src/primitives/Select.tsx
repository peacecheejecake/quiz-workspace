'use client';

import { Select as RadixSelect } from 'radix-ui';
import { useRef, useState, type ReactNode } from 'react';
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
  /**
   * Render the options only while the list is open. Radix otherwise renders every option of a
   * closed picker (into a detached fragment, for typeahead and form submission), so a page with
   * hundreds of pickers over a long list (QIMPORT-01 draft chapters) held hundreds of thousands
   * of nodes. The closed trigger shows the selected option's label; typing on the closed trigger
   * does not change the value (open the list first: Arrow keys and typeahead work there).
   */
  lazyOptions?: boolean;
}

/**
 * Labelled single-choice picker on Radix Select: the trigger is a `combobox` named by the visible
 * label, the popup a `listbox` of `option`s (Arrow keys, typeahead, Escape returns focus). Use it
 * for filters and form fields with a short, known list of choices.
 *
 * Touch and pen open the list on the trigger's click, here rather than in Radix (UX7-SELECT).
 * Radix records that click's position and cancels the next `pointerup` that has not moved 10px
 * from it, a guard against the mouse press that opened the list selecting the option under it.
 * A tap's pointerup comes before its click, so for a tap the guard instead hit the next tap (on
 * an option, without a pointermove), and iOS Safari drops the click of a cancelled touch pointerup:
 * the first tap on the open list (typically the selected option on top) did nothing. Mouse opening
 * keeps Radix's guard.
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
  lazyOptions = false,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const pointerTypeRef = useRef('touch');
  const [innerValue, setInnerValue] = useState(defaultValue);
  const current = value ?? innerValue;
  const selectedLabel = lazyOptions
    ? options.find((option) => option.value === current)?.label
    : undefined;
  const shownOptions = lazyOptions && !open ? [] : options;
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
        open={open}
        onOpenChange={setOpen}
        {...(lazyOptions
          ? {
              onValueChange: (next: string) => {
                setInnerValue(next);
                onValueChange?.(next);
              },
            }
          : onValueChange
            ? { onValueChange }
            : {})}
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
          onPointerDown={(event) => {
            pointerTypeRef.current = event.pointerType;
          }}
          onClick={(event) => {
            // Same as Radix's touch/pen path minus the recorded position (see above); the
            // prevented click skips Radix's handler. Keyboard opens on keydown, not here.
            if (pointerTypeRef.current === 'mouse') return;
            event.preventDefault();
            event.currentTarget.focus();
            if (!disabled) setOpen(true);
          }}
        >
          <span className="value">
            <RadixSelect.Value placeholder={placeholder}>
              {selectedLabel ?? undefined}
            </RadixSelect.Value>
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
              {shownOptions.map((option) => (
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
