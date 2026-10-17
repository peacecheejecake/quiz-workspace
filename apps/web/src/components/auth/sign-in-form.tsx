'use client';

// Minimal AUTH-01 sign-in form (A2.1). A2.2 owns the polished `SignInForm`/`AuthLayout` and may
// extend or replace this component; keep the labels (이메일 / 비밀번호), the `next` hidden field
// and the form-level `role="alert"` contract used by tests/e2e/fixtures/auth-ui.ts.
import { Button, Input } from '@quiz/ui';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { signInAction, type SignInState } from '@/lib/auth/actions';
import styles from './auth-form.module.css';

export interface SignInFormProps {
  /** Raw `next` from the URL; re-validated by the server action before redirecting. */
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

  return (
    <form action={formAction} className={styles.form}>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {state.error ? (
        <p role="alert" className={styles.alert}>
          {state.error}
        </p>
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
      />
      <Input
        label="비밀번호"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <SubmitButton />
    </form>
  );
}
