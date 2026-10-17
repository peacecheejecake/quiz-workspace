'use client';

// `PasswordResetForm` request step (AUTH-05). A malformed address is a field error and sends
// nothing (AUTH-05-AC02). Otherwise browser supabase-js asks Auth for a recovery mail; every
// answer except throttling/outage shows the same confirmation, whether or not the account exists
// (AUTH-05-AC01). Throttling and outages show a generic retry notice (AUTH-05-AC03).
import { Button, Input } from '@quiz/ui';
import { useState, type FormEvent } from 'react';
import { classifyMailRequestError, flowMessage } from '@/lib/auth/flow-errors';
import { normalizeEmail, validateEmail, VALIDATION_MESSAGES } from '@/lib/auth/validation';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import styles from './auth-form.module.css';
import { FormNotice } from './form-notice';
import { useFormErrors } from './use-form-errors';

export function PasswordResetRequestForm() {
  const { formRef, errors, show, clear } = useFormErrors<'email'>();
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<{ message: string; attempt: number }>();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const email = normalizeEmail(new FormData(event.currentTarget).get('email'));
    const invalid = validateEmail(email);
    show(invalid ? { email: invalid } : {});
    setFormError(undefined);
    if (invalid) return;

    setPending(true);
    let kind: ReturnType<typeof classifyMailRequestError>;
    try {
      const { error } = await getSupabaseBrowserClient().auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      });
      kind = error ? classifyMailRequestError(error) : 'ok';
    } catch {
      kind = 'unavailable';
    }
    setPending(false);

    if (kind === 'ok') {
      setSent(true);
    } else if (kind === 'invalidEmail') {
      show({ email: VALIDATION_MESSAGES.emailInvalid });
    } else {
      setFormError((prev) => ({
        message: flowMessage(kind === 'rateLimited' ? 'rateLimited' : 'unavailable'),
        attempt: (prev?.attempt ?? 0) + 1,
      }));
    }
  }

  if (sent) {
    return (
      <div className={styles.form}>
        <FormNotice tone="success" focusKey="sent">
          <p>
            입력한 주소로 가입된 계정이 있으면 비밀번호 재설정 링크를 보냈습니다. 받은 편지함과
            스팸함을 확인해 주세요.
          </p>
          <p>링크는 한 번만 사용할 수 있으며 일정 시간이 지나면 만료됩니다.</p>
        </FormNotice>
        <ul className={styles.actions}>
          <li>
            <Button variant="secondary" onClick={() => setSent(false)}>
              다른 이메일로 다시 요청하기
            </Button>
          </li>
        </ul>
      </div>
    );
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
      <Button type="submit" variant="primary" loading={pending} className={styles.submit}>
        재설정 링크 보내기
      </Button>
    </form>
  );
}
