'use client';

import { cx } from '../internal/cx';
import { IconButton, type IconButtonProps } from '../primitives/IconButton';
import { RetryIcon, StarIcon } from './icons';

export interface StudyToggleProps extends Omit<IconButtonProps, 'label' | 'icon' | 'onClick'> {
  /** Current state (favorite set / retry flagged). */
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
}

/*
 * The label names the action and flips with the state (`즐겨찾기 추가` ↔ `즐겨찾기 해제`), so
 * `aria-pressed` is deliberately not set: a pressed toggle whose name also changes would be
 * announced as e.g. "즐겨찾기 해제, pressed". `data-state` drives the visual "on" style.
 */
function StudyToggle({
  pressed,
  onPressedChange,
  onLabel,
  offLabel,
  icon,
  className,
  ...rest
}: StudyToggleProps & { onLabel: string; offLabel: string; icon: IconButtonProps['icon'] }) {
  return (
    <IconButton
      label={pressed ? onLabel : offLabel}
      icon={icon}
      data-state={pressed ? 'on' : 'off'}
      className={cx('qz-study-toggle', className)}
      onClick={() => onPressedChange(!pressed)}
      {...rest}
    />
  );
}

/** Favorite toggle (panel header / bank rows): `즐겨찾기 추가` / `즐겨찾기 해제`. */
export function FavoriteToggle(props: StudyToggleProps) {
  return (
    <StudyToggle
      {...props}
      onLabel="즐겨찾기 해제"
      offLabel="즐겨찾기 추가"
      icon={<StarIcon filled={props.pressed} />}
    />
  );
}

/** Retry flag toggle: `다시 풀기 표시` / `다시 풀기 해제`. Never cleared automatically. */
export function RetryToggle(props: StudyToggleProps) {
  return (
    <StudyToggle
      {...props}
      onLabel="다시 풀기 해제"
      offLabel="다시 풀기 표시"
      icon={<RetryIcon />}
    />
  );
}
