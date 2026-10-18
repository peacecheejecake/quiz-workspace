'use client';

// `SignInForm` (AUTH-01). Credentials are posted to the `signInAction` server action, so the
// password never passes through browser-side Supabase code (implementation-plan §7). Client-side
// checks only catch empty/malformed input before the request. Contract with
// tests/e2e/fixtures/auth-ui.ts: labels 이메일 / 비밀번호, hidden `next`, form errors as
// `role="alert"` inside <main>. With CAPTCHA on, the Turnstile token rides along as a hidden field
// and the widget is reset after every action result (docs/auth.md §5.1, AUTH-01-AC05/06).
import { Button, Input } from '@quiz/ui';
import Link from 'next/link';
import { useActionState, useEffect, useRef, type FormEvent } from 'react';
import { useFormStatus } from 'react-dom';
import { signInAction, type SignInState } from '@/lib/auth/actions';
import { CAPTCHA_FIELD } from '@/lib/auth/captcha';
import { hasErrors, normalizeEmail, validateSignIn } from '@/lib/auth/validation';
import styles from './auth-form.module.css';
import { useCaptcha, type Captcha } from './captcha-field';
import { FormNotice } from './form-notice';
import { useFormErrors } from './use-form-errors';

export interface SignInFormProps {
  /** Validated internal `next`; the server action re-validates it before redirecting. */
  next?: string | undefined;
}

function SubmitButton({ captcha }: { captcha: Captcha }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="primary"
      loading={pending}
      className={styles.submit}
      {...captcha.submitProps}
    >
      로그인
    </Button>
  );
}

const INITIAL_STATE: SignInState = {};

export function SignInForm({ next }: SignInFormProps) {
  const [state, formAction] = useActionState<SignInState, FormData>(signInAction, INITIAL_STATE);
  const { formRef, errors, show, clear } = useFormErrors<'email' | 'password'>();
  const captcha = useCaptcha('로그인할');
  const { reset: resetCaptcha } = captcha;
  const resetRef = useRef(resetCaptcha);
  useEffect(() => {
    resetRef.current = resetCaptcha;
  });
  // Every action result means Auth saw (or refused to see) this token: never send it again.
  useEffect(() => {
    if (state !== INITIAL_STATE) resetRef.current();
  }, [state]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    const found = validateSignIn({
      email: normalizeEmail(data.get('email')),
      password: String(data.get('password') ?? ''),
    });
    show(found);
    // Invalid input never reaches the server action; neither does a submit without a token.
    if (hasErrors(found)) {
      event.preventDefault();
    } else if (captcha.blocked) {
      event.preventDefault();
      captcha.remind();
    }
  }

  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} noValidate className={styles.form}>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {captcha.enabled ? (
        <input type="hidden" name={CAPTCHA_FIELD} value={captcha.token ?? ''} />
      ) : null}
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
      {captcha.field}
      <SubmitButton captcha={captcha} />
    </form>
  );
}
