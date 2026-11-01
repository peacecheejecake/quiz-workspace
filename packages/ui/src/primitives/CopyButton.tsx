'use client';

import { useEffect, useRef, useState } from 'react';
import { cx } from '../internal/cx';
import { Button, type ButtonProps } from './Button';
import { CheckIcon, CopyIcon } from './icons';

/** How long the "copied" state (check icon, copied label) stays before the button reverts. */
export const COPY_FEEDBACK_MS = 2000;

export interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children' | 'asChild'> {
  /** Visible label and accessible name, e.g. "링크 복사". */
  label: string;
  /** Label while the copied state lasts. */
  copiedLabel?: string;
  /** Read once by a polite live region after a successful copy, e.g. "링크를 복사했습니다.". */
  announcement: string;
  /**
   * Does the copy. Resolving `false` or rejecting is a failure: no check is shown and the caller
   * reports the error (e.g. a toast).
   */
  onCopy: () => Promise<boolean>;
  feedbackMs?: number;
}

const HIDDEN = { visibility: 'hidden' } as const;

/**
 * Clipboard copy button (docs/design-system.md CopyButton, UX7-SHARE-EXPIRY). After a successful
 * copy the copy icon becomes a check and the label `copiedLabel` for `feedbackMs`. Both icons and
 * both labels share one grid cell and the inactive one is `visibility: hidden` (out of the
 * accessibility tree, still in the layout), so the swap never resizes or moves the button. No
 * animation. The live region sits next to the button so the button's name stays the label.
 */
export function CopyButton({
  label,
  copiedLabel = '복사됨',
  announcement,
  onCopy,
  feedbackMs = COPY_FEEDBACK_MS,
  className,
  ...rest
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    window.clearTimeout(timer.current);
    setCopied(false);
    let ok: boolean;
    try {
      ok = await onCopy();
    } catch {
      ok = false;
    }
    if (!ok) return;
    setCopied(true);
    timer.current = window.setTimeout(() => setCopied(false), feedbackMs);
  }

  return (
    <>
      <Button
        {...rest}
        className={cx('qz-copy-button', className)}
        data-copied={copied || undefined}
        onClick={() => void copy()}
      >
        <span className="icons" aria-hidden="true">
          <CopyIcon data-icon="copy" width={16} height={16} style={copied ? HIDDEN : undefined} />
          <CheckIcon data-icon="check" width={16} height={16} style={copied ? undefined : HIDDEN} />
        </span>
        <span className="labels">
          <span data-slot="label" style={copied ? HIDDEN : undefined}>
            {label}
          </span>
          <span data-slot="label" style={copied ? undefined : HIDDEN}>
            {copiedLabel}
          </span>
        </span>
      </Button>
      <span role="status" className="qz-visually-hidden">
        {copied ? announcement : ''}
      </span>
    </>
  );
}
