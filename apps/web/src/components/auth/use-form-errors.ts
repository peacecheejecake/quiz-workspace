'use client';

// Field-error state shared by the auth forms: errors are shown through @quiz/ui `Input` (which
// sets aria-invalid + aria-describedby), the first invalid control receives focus after each
// failed submit, and editing a field clears its own error.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { FieldErrors } from '@/lib/auth/validation';

export interface FormErrors<K extends string> {
  readonly formRef: RefObject<HTMLFormElement | null>;
  readonly errors: FieldErrors<K>;
  /** Replaces the errors and focuses the first invalid control. */
  readonly show: (errors: FieldErrors<K>) => void;
  /** Clears one field's error (wire to the field's onChange). */
  readonly clear: (field: K) => void;
}

export function useFormErrors<K extends string>(): FormErrors<K> {
  const formRef = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<FieldErrors<K>>({});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (attempt === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [attempt]);

  const show = useCallback((next: FieldErrors<K>) => {
    setErrors(next);
    if (Object.keys(next).length > 0) setAttempt((n) => n + 1);
  }, []);

  const clear = useCallback((field: K) => {
    setErrors((current) => {
      if (!(field in current)) return current;
      return Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== field),
      ) as FieldErrors<K>;
    });
  }, []);

  return { formRef, errors, show, clear };
}
