'use client';

// `SignUpForm` (AUTH-02). Validates in the browser first (policy: ≥10 characters, matching
// confirmation) so invalid input never calls the Auth API (AUTH-02-AC02), then signs up through
// browser supabase-js (implementation-plan §7). An address that already has an account looks
// exactly like a new one (AUTH-02-AC03): Auth answers both with "check your email", and any
// existence error is treated the same way.
import { Button, Input } from '@quiz/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { classifySignUpError, flowMessage } from '@/lib/auth/flow-errors';
import { pendingEmailCookie } from '@/lib/auth/pending-email';
import {
  hasErrors,
  normalizeEmail,
  PASSWORD_HINT,
  validateSignUp,
  VALIDATION_MESSAGES,
} from '@/lib/auth/validation';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import styles from './auth-form.module.css';
import { FormNotice } from './form-notice';
import { useFormErrors } from './use-form-errors';

type Field = 'email' | 'password' | 'confirm';

export function SignUpForm() {
  const router = useRouter();
  const { formRef, errors, show, clear } = useFormErrors<Field>();
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<{ message: string; attempt: number }>();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const email = normalizeEmail(data.get('email'));
    const password = String(data.get('password') ?? '');
    const found = validateSignUp({ email, password, confirm: String(data.get('confirm') ?? '') });
    show(found);
    setFormError(undefined);
    if (hasErrors(found)) return;

    setPending(true);
    let kind: ReturnType<typeof classifySignUpError>;
    try {
      const { error } = await getSupabaseBrowserClient().auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      kind = error ? classifySignUpError(error) : 'ok';
    } catch {
      kind = 'unavailable';
    }

    if (kind === 'ok') {
      document.cookie = pendingEmailCookie(email, window.location.protocol === 'https:');
      router.push('/auth/verify');
      return; // stays pending until the verify screen replaces this one
    }
    setPending(false);
    if (kind === 'weakPassword') {
      show({ password: VALIDATION_MESSAGES.passwordTooShort });
    } else if (kind === 'invalidEmail') {
      show({ email: VALIDATION_MESSAGES.emailInvalid });
    } else {
      setFormError((prev) => ({ message: flowMessage(kind), attempt: (prev?.attempt ?? 0) + 1 }));
    }
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className={styles.form}>
      {formError ? (
        <FormNotice tone="danger" focusKey={formError.attempt}>
          <p>{formError.message}</p>
        </FormNotice>
      ) : null}
      <Input
        label="이메일"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        autoCapitalize="none"
        spellCheck={false}
        required
        error={errors.email}
        onChange={() => clear('email')}
      />
      <Input
        label="비밀번호"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        description={PASSWORD_HINT}
        error={errors.password}
        onChange={() => clear('password')}
      />
      <Input
        label="비밀번호 확인"
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
        error={errors.confirm}
        onChange={() => clear('confirm')}
      />
      <p className={styles.fine}>
        가입하면 <Link href="/terms">이용약관</Link>과{' '}
        <Link href="/privacy">개인정보 처리방침</Link>에 동의하는 것으로 간주됩니다.
      </p>
      <Button type="submit" variant="primary" loading={pending} className={styles.submit}>
        회원가입
      </Button>
    </form>
  );
}
