'use client';

// `CaptchaField` — the shared "보안 확인" region of the auth forms (docs/auth.md §5.1, AUTH-01-AC05/06,
// AUTH-02-AC04/05, AUTH-03-AC04/05, AUTH-05-AC04/05). Renders Cloudflare Turnstile explicitly
// and reports its single-use token to the form. State is always spelled out in a polite
// `role="status"` line (never colour alone); failures offer a real "보안 확인 다시 하기" button.
// Nothing here animates. Contract with tests/e2e/fixtures/turnstile.ts: group named "보안 확인",
// status inside it, retry button label, blocked reason "보안 확인을 완료하면 …할 수 있습니다".
//
// `useCaptcha` keeps the token in the form; after every Auth call the form calls `reset()`, which
// discards the token and asks Turnstile for a new one (a token is never sent twice).
import { Button } from '@quiz/ui';
import { useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { turnstileSiteKey } from '@/env';
import {
  CAPTCHA_MESSAGES,
  captchaRequiredMessage,
  loadTurnstile,
  type TurnstileApi,
} from '@/lib/auth/captcha';
import styles from './captcha.module.css';

export type CaptchaStatus = 'loading' | 'verified' | 'failed' | 'expired' | 'unavailable';

export interface CaptchaFieldHandle {
  /** Drops the current token and starts a new challenge (after each Auth call, or on demand). */
  reset(): void;
  /** Moves focus to the region (submit attempted without a token). */
  focus(): void;
  /** Resolves with the next token, or undefined if none arrives within `timeoutMs`. */
  nextToken(timeoutMs: number): Promise<string | undefined>;
}

export interface CaptchaFieldProps {
  sitekey: string;
  /** Clause of the blocked reason: "로그인할" → "보안 확인을 완료하면 로그인할 수 있습니다." */
  action: string;
  /** Id of the blocked-reason text, for the submit control's `aria-describedby`. */
  reasonId: string;
  onToken: (token: string | undefined) => void;
  ref?: Ref<CaptchaFieldHandle>;
}

export function CaptchaField({ sitekey, action, reasonId, onToken, ref }: CaptchaFieldProps) {
  const headingId = useId();
  const statusId = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const api = useRef<TurnstileApi | undefined>(undefined);
  const widgetId = useRef<string | undefined>(undefined);
  const waiters = useRef<((token: string | undefined) => void)[]>([]);
  const [status, setStatus] = useState<CaptchaStatus>('loading');
  const [attempt, setAttempt] = useState(0);

  const deliver = useCallback(
    (token: string | undefined) => {
      onToken(token);
      if (token === undefined) return;
      const pending = waiters.current;
      waiters.current = [];
      for (const resolve of pending) resolve(token);
    },
    [onToken],
  );

  // (Re)load the script and render the widget. `attempt` bumps on "다시 하기" after a load
  // failure, so the effect runs again with a fresh loader.
  useEffect(() => {
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        const container = containerRef.current;
        if (cancelled || !container) return;
        api.current = turnstile;
        widgetId.current = turnstile.render(container, {
          sitekey,
          language: 'ko',
          theme: 'auto',
          size: 'flexible',
          'response-field': false,
          'refresh-expired': 'manual',
          'refresh-timeout': 'manual',
          callback: (token) => {
            setStatus('verified');
            deliver(token);
          },
          'error-callback': () => {
            setStatus('failed');
            deliver(undefined);
            return true; // handled: Turnstile does not retry or log on its own
          },
          'expired-callback': () => {
            setStatus('expired');
            deliver(undefined);
          },
          'timeout-callback': () => {
            setStatus('expired');
            deliver(undefined);
          },
        });
      })
      .catch(() => {
        if (!cancelled) setStatus('unavailable');
      });
    return () => {
      cancelled = true;
      if (api.current && widgetId.current !== undefined) api.current.remove(widgetId.current);
      widgetId.current = undefined;
    };
  }, [sitekey, attempt, deliver]);

  const reset = useCallback(() => {
    deliver(undefined);
    if (api.current && widgetId.current !== undefined) {
      setStatus('loading');
      api.current.reset(widgetId.current);
    } else {
      // Script never loaded (or no widget yet): load and render again.
      setStatus('loading');
      setAttempt((n) => n + 1);
    }
  }, [deliver]);

  useImperativeHandle(
    ref,
    () => ({
      reset,
      focus: () => groupRef.current?.focus(),
      nextToken: (timeoutMs) =>
        new Promise<string | undefined>((resolve) => {
          const timer = window.setTimeout(() => {
            waiters.current = waiters.current.filter((w) => w !== done);
            resolve(undefined);
          }, timeoutMs);
          const done = (token: string | undefined) => {
            window.clearTimeout(timer);
            resolve(token);
          };
          waiters.current.push(done);
        }),
    }),
    [reset],
  );

  const retryable = status === 'failed' || status === 'expired' || status === 'unavailable';
  return (
    <div
      ref={groupRef}
      role="group"
      aria-labelledby={headingId}
      aria-describedby={status === 'verified' ? statusId : `${statusId} ${reasonId}`}
      tabIndex={-1}
      className={styles.region}
      data-status={status}
    >
      <p id={headingId} className={styles.title}>
        보안 확인
      </p>
      <div ref={containerRef} className={styles.widget} />
      <p id={statusId} role="status" className={styles.status}>
        {CAPTCHA_MESSAGES[status]}
      </p>
      {status === 'verified' ? null : (
        <p id={reasonId} className={styles.reason}>
          {captchaRequiredMessage(action)}
        </p>
      )}
      {retryable ? (
        <Button variant="secondary" onClick={reset} className={styles.retry}>
          보안 확인 다시 하기
        </Button>
      ) : null}
    </div>
  );
}

export interface Captcha {
  /** False when no sitekey is configured: forms behave exactly as before (no token). */
  readonly enabled: boolean;
  readonly token: string | undefined;
  /** True while CAPTCHA is on and no token is held: the submit control is `aria-disabled`. */
  readonly blocked: boolean;
  /** Props for the submit control (blocked state + reason). */
  readonly submitProps: { 'aria-disabled'?: true; 'aria-describedby'?: string };
  /** The region to render inside the form (null when disabled). */
  readonly field: ReactNode;
  /** Submit attempted without a token: focus the region (its description says why). */
  remind(): void;
  /** After an Auth call: forget the spent token and fetch a new one. */
  reset(): void;
  nextToken(timeoutMs: number): Promise<string | undefined>;
}

/** Wires a form to the shared CAPTCHA region. `action` is the clause of the blocked reason. */
export function useCaptcha(action: string): Captcha {
  const sitekey = turnstileSiteKey();
  const reasonId = useId();
  const handle = useRef<CaptchaFieldHandle>(null);
  const [token, setToken] = useState<string>();
  const enabled = sitekey !== undefined;
  const blocked = enabled && token === undefined;
  return {
    enabled,
    token: enabled ? token : undefined,
    blocked,
    submitProps: blocked ? { 'aria-disabled': true, 'aria-describedby': reasonId } : {},
    field: sitekey ? (
      <CaptchaField
        ref={handle}
        sitekey={sitekey}
        action={action}
        reasonId={reasonId}
        onToken={setToken}
      />
    ) : null,
    remind: () => handle.current?.focus(),
    reset: () => {
      setToken(undefined);
      handle.current?.reset();
    },
    nextToken: (timeoutMs) =>
      handle.current ? handle.current.nextToken(timeoutMs) : Promise.resolve(undefined),
  };
}
