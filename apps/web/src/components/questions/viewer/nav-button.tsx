import { ArrowLeftIcon, IconButton } from '@quiz/ui';
import type { ComponentProps } from 'react';

/**
 * Previous/next arrow of the viewers' footers, as tall as `제출` (UX10-QVIEW-AC02, UX12-VIEW-AC01).
 * While it cannot move the button stays focusable (`aria-disabled`), so focus does not drop out of
 * the panel when the last question is reached.
 */
export function NavButton({
  direction,
  label,
  unavailable,
  variant = 'ghost',
  onClick,
}: {
  readonly direction: 'previous' | 'next';
  readonly label: string;
  readonly unavailable: boolean;
  readonly variant?: ComponentProps<typeof IconButton>['variant'];
  readonly onClick: () => void;
}) {
  return (
    <IconButton
      label={label}
      variant={variant}
      icon={
        <ArrowLeftIcon
          width={20}
          height={20}
          style={direction === 'next' ? { transform: 'rotate(180deg)' } : undefined}
        />
      }
      aria-disabled={unavailable || undefined}
      onClick={() => {
        if (!unavailable) onClick();
      }}
    />
  );
}
