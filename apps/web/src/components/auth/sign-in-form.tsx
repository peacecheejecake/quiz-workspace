'use client';

// `SignInForm` (AUTH-01). Credentials are posted to the `signInAction` server action, so the
// password never passes through browser-side Supabase code (implementation-plan §7). Client-side
// checks only catch empty/malformed input before the request. Contract with
// tests/e2e/fixtures/auth-ui.ts: labels 이메일 / 비밀번호, hidden `next`, form errors as
// `role="alert"` inside <main>.
import { Button, Input } from '@quiz/ui';
import Link from 'next/link';
import { useActionState, type FormEvent } from 'react';
import { useFormStatus } from 'react-dom';
import { signInAction, type SignInState } from '@/lib/auth/actions';
import { hasErrors, normalizeEmail, validateSignIn } from '@/lib/auth/validation';
import styles from './auth-form.module.css';
import { FormNotice } from './form-notice';
import { useFormErrors } from './use-form-errors';

export interface SignInFormProps {
  /** Validated internal `next`; the server action re-validates it before redirecting. */
  next?: string | undefined;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" loading={pending} className={styles.submit}>
      로그인
    </Button>
  );
}

export function SignInForm({ next }: SignInFormProps) {
  const [state, formAction] = useActionState<SignInState, FormData>(signInAction, {});
  const { formRef, errors, show, clear } = useFormErrors<'email' | 'password'>();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    const found = validateSignIn({
      email: normalizeEmail(data.get('email')),
      password: String(data.get('password') ?? ''),
    });
    show(found);
    // Invalid input never reaches the server action.
    if (hasErrors(found)) event.preventDefault();
  }

  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} noValidate className={styles.form}>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {state.error ? (
        <FormNotice tone="danger" focusKey={state}>
          <p>{state.error}</p>
          {state.emailNotConfirmed ? (
            <p>
              <Link href="/auth/verify">인증 메일 다시 받기</Link>
            </p>
          ) : null}
        </FormNotice>
      ) : null}
      <Input
        // Remount after each attempt so the address survives React's post-action form reset.
        key={`email-${state.email ?? ''}`}
        label="이메일"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        autoCapitalize="none"
        spellCheck={false}
        required
        defaultValue={state.email ?? ''}
        error={errors.email}
        onChange={() => clear('email')}
      />
      <Input
        label="비밀번호"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        error={errors.password}
        onChange={() => clear('password')}
      />
      <SubmitButton />
    </form>
  );
}
