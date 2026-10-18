'use client';

import { Switch as RadixSwitch } from 'radix-ui';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { cx } from '../internal/cx';

export interface SwitchProps extends Omit<ComponentProps<typeof RadixSwitch.Root>, 'children'> {
  /** Visible label (required: names the switch). */
  label: ReactNode;
  description?: ReactNode;
  /** Visible state text next to the track (state is never conveyed by color alone). */
  stateLabels?: { readonly on: ReactNode; readonly off: ReactNode };
}

/**
 * Radix switch (role="switch") for settings that apply immediately. The thumb position and the
 * state text carry the state; the accent color only reinforces it.
 */
export function Switch({
  label,
  description,
  stateLabels = { on: '켜짐', off: '꺼짐' },
  id,
  className,
  ...rest
}: SwitchProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const descriptionId = `${controlId}-description`;
  const on = rest.checked ?? false;
  return (
    <div className={cx('qz-switch', className)}>
      <div className="qz-switch__text">
        <label htmlFor={controlId} className="qz-switch__label">
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="qz-field__description">
            {description}
          </p>
        ) : null}
      </div>
      <div className="qz-switch__control">
        {rest.checked === undefined ? null : (
          <span className="qz-switch__state" aria-hidden="true">
            {on ? stateLabels.on : stateLabels.off}
          </span>
        )}
        <RadixSwitch.Root
          id={controlId}
          aria-describedby={description ? descriptionId : undefined}
          className="qz-switch__track qz-focus-ring"
          {...rest}
        >
          <RadixSwitch.Thumb className="qz-switch__thumb" />
        </RadixSwitch.Root>
      </div>
    </div>
  );
}
