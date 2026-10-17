'use client';

// Form-level message for the auth screens. Errors use `role="alert"` (the tests' `formAlert`),
// confirmations `role="status"`. State is conveyed by icon + text, never colour alone. When
// `focusKey` changes the notice takes focus, so keyboard and screen-reader users land on it.
import { AlertIcon, CheckIcon } from '@quiz/ui';
import { useEffect, useRef, type ReactNode } from 'react';
import styles from './auth-form.module.css';

export interface FormNoticeProps {
  tone: 'danger' | 'success' | 'info';
  children: ReactNode;
  /** Move focus to the notice whenever this value changes (omit to never move focus). */
  focusKey?: unknown;
}

export function FormNotice({ tone, children, focusKey }: FormNoticeProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusKey !== undefined) ref.current?.focus();
  }, [focusKey]);

  return (
    <div
      ref={ref}
      role={tone === 'danger' ? 'alert' : 'status'}
      tabIndex={-1}
      data-tone={tone}
      className={styles.notice}
    >
      {tone === 'danger' ? (
        <AlertIcon width={18} height={18} aria-hidden="true" />
      ) : (
        <CheckIcon width={18} height={18} aria-hidden="true" />
      )}
      <div className={styles.noticeBody}>{children}</div>
    </div>
  );
}
