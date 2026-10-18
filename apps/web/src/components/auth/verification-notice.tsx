'use client';

// `VerificationNotice` resend control (AUTH-03). Resends the sign-up confirmation through browser
// supabase-js, then blocks further sends for a cooldown with a visible countdown (AUTH-03-AC02).
// Auth throttling (429) starts the same cooldown. Unknown/confirmed addresses get the same
// "sent" answer as pending ones, so the control never reveals whether an account exists. The
// address comes from the pending-email cookie (set by sign-up, or by sign-in for an unconfirmed
// account); the user can switch to another address, and without one (e.g. arriving from
// /auth/error) types it. With CAPTCHA on, each send carries a fresh Turnstile token and the widget
// is reset afterwards; the short-throttle retry waits for a new token (docs/auth.md §5.1).
import { Button, Input } from '@quiz/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  classifyMailRequestError,
  flowMessage,
  retryAfterSeconds,
  SHORT_THROTTLE_SECONDS,
} from '@/lib/auth/flow-errors';
import { pendingEmailCookie } from '@/lib/auth/pending-email';
import { normalizeEmail, validateEmail, VALIDATION_MESSAGES } from '@/lib/auth/validation';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import styles from './auth-form.module.css';
import { useCaptcha } from './captcha-field';
import { FormNotice } from './form-notice';

export const RESEND_COOLDOWN_SECONDS = 60;

type Outcome =
  | { kind: 'sent'; attempt: number }
  | { kind: 'error'; message: string; attempt: number }
  | undefined;

export function VerificationNotice({ email: initialEmail }: { email?: string | undefined }) {
  const [target, setTarget] = useState(initialEmail);
  const [editing, setEditing] = useState(!initialEmail);
  const [pending, setPending] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<number>();
  const [now, setNow] = useState(() => Date.now());
  const [outcome, setOutcome] = useState<Outcome>();
  const [emailError, setEmailError] = useState<string>();
  const emailRef = useRef<HTMLInputElement>(null);
  const attempts = useRef(0);
  const captcha = useCaptcha('인증 메일을 다시 보낼');

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

  // Opening "받는 주소 바꾸기" moves focus into the address field.
  const openedByUser = useRef(false);
  useEffect(() => {
    if (editing && openedByUser.current) emailRef.current?.focus();
  }, [editing]);

  function startCooldown() {
    const start = Date.now();
    setNow(start);
    setCooldownUntil(start + RESEND_COOLDOWN_SECONDS * 1000);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || coolingDown) return;
    const email =
      editing || !target ? normalizeEmail(new FormData(event.currentTarget).get('email')) : target;
    const invalid = validateEmail(email);
    setEmailError(invalid);
    if (invalid) {
      emailRef.current?.focus();
      return;
    }
    if (captcha.blocked) {
      captcha.remind();
      return;
    }

    setPending(true);
    const send = (captchaToken: string | undefined) =>
      getSupabaseBrowserClient().auth.resend({
        type: 'signup',
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          ...(captchaToken ? { captchaToken } : {}),
        },
      });
    let kind: ReturnType<typeof classifyMailRequestError>;
    try {
      let token = captcha.token;
      let { error } = await send(token);
      // Right after sign-up Auth may still hold this address for a second or two (per-user mail
      // frequency): wait that out once instead of failing the click. The first call spent the
      // CAPTCHA token, so the retry waits for a new one (none in time: report the throttle).
      const wait = error ? retryAfterSeconds(error) : undefined;
      if (wait !== undefined && wait <= SHORT_THROTTLE_SECONDS) {
        const delay = new Promise((resolve) => window.setTimeout(resolve, (wait + 1) * 1000));
        if (token) {
          const next = captcha.nextToken((wait + 10) * 1000);
          captcha.reset();
          token = await next;
        }
        await delay;
        if (!captcha.enabled || token) ({ error } = await send(token));
      }
      if (token) captcha.reset();
      kind = error ? classifyMailRequestError(error) : 'ok';
    } catch {
      if (captcha.token) captcha.reset();
      kind = 'unavailable';
    }
    setPending(false);
    attempts.current += 1;
    const attempt = attempts.current;

    if (kind === 'ok') {
      startCooldown();
      setOutcome({ kind: 'sent', attempt });
      if (email !== target) {
        setTarget(email);
        document.cookie = pendingEmailCookie(email, window.location.protocol === 'https:');
      }
      setEditing(false);
    } else if (kind === 'invalidEmail' && (editing || !target)) {
      setEmailError(VALIDATION_MESSAGES.emailInvalid);
      setOutcome(undefined);
      emailRef.current?.focus();
    } else {
      if (kind === 'rateLimited') startCooldown();
      setOutcome({
        kind: 'error',
        message: flowMessage(
          kind === 'rateLimited' || kind === 'captchaFailed' ? kind : 'unavailable',
        ),
        attempt,
      });
    }
  }

  return (
    <>
      <p className={styles.body}>
        {target ? (
          <>
            <span className={styles.email}>{target}</span> 주소로 인증 메일을 보냈습니다.
          </>
        ) : (
          '가입할 때 입력한 주소로 인증 메일을 보냈습니다.'
        )}{' '}
        메일의 링크를 열면 인증이 완료되고, 그 전에는 Workspace를 이용할 수 없습니다.
      </p>
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
        {editing || !target ? (
          <Input
            ref={emailRef}
            key={target ?? ''}
            defaultValue={target ?? ''}
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
        ) : null}
        {captcha.field}
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          disabled={coolingDown}
          {...(coolingDown ? {} : captcha.submitProps)}
          aria-describedby={
            coolingDown ? 'resend-cooldown' : captcha.submitProps['aria-describedby']
          }
          className={styles.submit}
        >
          인증 메일 다시 보내기
        </Button>
        {coolingDown ? (
          <p id="resend-cooldown" className={styles.fine}>
            메일을 너무 자주 보낼 수 없습니다. {remaining}초 후에 다시 보낼 수 있습니다.
          </p>
        ) : null}
        {target ? (
          <Button
            variant="ghost"
            onClick={() => {
              openedByUser.current = true;
              setEditing((value) => !value);
              setEmailError(undefined);
            }}
            aria-expanded={editing}
          >
            {editing ? '주소 변경 취소' : '받는 주소 바꾸기'}
          </Button>
        ) : null}
      </form>
    </>
  );
}
