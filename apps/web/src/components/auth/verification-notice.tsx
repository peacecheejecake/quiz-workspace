'use client';

// `VerificationNotice` resend control (AUTH-03). Resends the sign-up confirmation through browser
// supabase-js, then blocks further sends for a cooldown with a visible countdown (AUTH-03-AC02).
// Auth throttling (429) starts the same cooldown. Unknown/confirmed addresses get the same
// "sent" answer as pending ones, so the control never reveals whether an account exists. Without a
// known pending address (e.g. arriving from /auth/error) the user types it.
import { Button, Input } from '@quiz/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  classifyMailRequestError,
  flowMessage,
  retryAfterSeconds,
  SHORT_THROTTLE_SECONDS,
} from '@/lib/auth/flow-errors';
import { normalizeEmail, validateEmail, VALIDATION_MESSAGES } from '@/lib/auth/validation';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import styles from './auth-form.module.css';
import { FormNotice } from './form-notice';

export const RESEND_COOLDOWN_SECONDS = 60;

type Outcome =
  | { kind: 'sent'; attempt: number }
  | { kind: 'error'; message: string; attempt: number }
  | undefined;

export function VerificationResend({ email: knownEmail }: { email?: string | undefined }) {
  const [pending, setPending] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<number>();
  const [now, setNow] = useState(() => Date.now());
  const [outcome, setOutcome] = useState<Outcome>();
  const [emailError, setEmailError] = useState<string>();
  const emailRef = useRef<HTMLInputElement>(null);
  const attempts = useRef(0);

  const remaining = cooldownUntil ? Math.max(0, Math.ceil((cooldownUntil - now) / 1000)) : 0;
  const coolingDown = remaining > 0;

  useEffect(() => {
    if (!cooldownUntil) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= cooldownUntil) {
        setCooldownUntil(undefined);
        window.clearInterval(timer);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  function startCooldown() {
    const start = Date.now();
    setNow(start);
    setCooldownUntil(start + RESEND_COOLDOWN_SECONDS * 1000);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || coolingDown) return;
    const email = knownEmail ?? normalizeEmail(new FormData(event.currentTarget).get('email'));
    const invalid = knownEmail ? undefined : validateEmail(email);
    setEmailError(invalid);
    if (invalid) {
      emailRef.current?.focus();
      return;
    }

    setPending(true);
    const send = () =>
      getSupabaseBrowserClient().auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
    let kind: ReturnType<typeof classifyMailRequestError>;
    try {
      let { error } = await send();
      // Right after sign-up Auth may still hold this address for a second or two (per-user mail
      // frequency): wait that out once instead of failing the click.
      const wait = error ? retryAfterSeconds(error) : undefined;
      if (wait !== undefined && wait <= SHORT_THROTTLE_SECONDS) {
        await new Promise((resolve) => window.setTimeout(resolve, (wait + 1) * 1000));
        ({ error } = await send());
      }
      kind = error ? classifyMailRequestError(error) : 'ok';
    } catch {
      kind = 'unavailable';
    }
    setPending(false);
    attempts.current += 1;
    const attempt = attempts.current;

    if (kind === 'ok') {
      startCooldown();
      setOutcome({ kind: 'sent', attempt });
    } else if (kind === 'invalidEmail' && !knownEmail) {
      setEmailError(VALIDATION_MESSAGES.emailInvalid);
      setOutcome(undefined);
      emailRef.current?.focus();
    } else {
      if (kind === 'rateLimited') startCooldown();
      setOutcome({
        kind: 'error',
        message: flowMessage(kind === 'rateLimited' ? 'rateLimited' : 'unavailable'),
        attempt,
      });
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className={styles.form}>
      {outcome?.kind === 'sent' ? (
        <FormNotice tone="success">
          <p>인증 메일을 다시 보냈습니다. 받은 편지함과 스팸함을 확인해 주세요.</p>
        </FormNotice>
      ) : null}
      {outcome?.kind === 'error' ? (
        <FormNotice tone="danger" focusKey={outcome.attempt}>
          <p>{outcome.message}</p>
        </FormNotice>
      ) : null}
      {knownEmail ? null : (
        <Input
          ref={emailRef}
          label="이메일"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          description="가입할 때 입력한 이메일 주소로 인증 메일을 다시 보냅니다."
          error={emailError}
          onChange={() => setEmailError(undefined)}
        />
      )}
      <Button
        type="submit"
        variant="primary"
        loading={pending}
        disabled={coolingDown}
        aria-describedby={coolingDown ? 'resend-cooldown' : undefined}
        className={styles.submit}
      >
        인증 메일 다시 보내기
      </Button>
      {coolingDown ? (
        <p id="resend-cooldown" className={styles.fine}>
          메일을 너무 자주 보낼 수 없습니다. {remaining}초 후에 다시 보낼 수 있습니다.
        </p>
      ) : null}
    </form>
  );
}
