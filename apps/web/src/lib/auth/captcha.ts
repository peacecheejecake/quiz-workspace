// Cloudflare Turnstile client glue for the auth CAPTCHA (docs/auth.md §5.1). Supabase Auth
// verifies the tokens; the browser only obtains one per Auth call and passes it along. Nothing
// here is secret: the sitekey is public and tokens are single-use and short-lived. Tokens are
// never logged or put into a URL.

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const TURNSTILE_SCRIPT_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;

/** Form field that carries the token to the sign-in Server Action. */
export const CAPTCHA_FIELD = 'captchaToken';

export const CAPTCHA_MESSAGES = {
  loading: '보안 확인 중입니다. 확인란이 보이면 선택해 주세요.',
  verified: '보안 확인 완료',
  failed: '보안 확인을 완료하지 못했습니다. 다시 시도해 주세요.',
  expired: '보안 확인 시간이 지났습니다. 다시 확인해 주세요.',
  unavailable: '보안 확인을 불러오지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.',
  /** Supabase refused the token (`captcha_failed`). */
  rejected: '보안 확인에 실패했습니다. 보안 확인을 마친 뒤 다시 시도해 주세요.',
} as const;

/**
 * "보안 확인을 완료하면 <clause> 수 있습니다." — the reason a submit control is blocked. `clause` is
 * the adnominal phrase, e.g. "로그인할", "인증 메일을 다시 보낼".
 */
export function captchaRequiredMessage(clause: string): string {
  return `보안 확인을 완료하면 ${clause} 수 있습니다.`;
}

/** Supabase answers a missing/invalid/spent token with `captcha_failed` (HTTP 400). */
export function isCaptchaError(error: { readonly code?: string | undefined }): boolean {
  return error.code === 'captcha_failed';
}

// --- the Turnstile browser API (subset used here) -----------------------------------------------

export interface TurnstileRenderOptions {
  sitekey: string;
  language?: string;
  theme?: 'auto' | 'light' | 'dark';
  size?: 'normal' | 'flexible' | 'compact';
  'response-field'?: boolean;
  'refresh-expired'?: 'auto' | 'manual' | 'never';
  'refresh-timeout'?: 'auto' | 'manual' | 'never';
  callback?: (token: string) => void;
  'error-callback'?: (code: string) => boolean | undefined;
  'expired-callback'?: () => void;
  'timeout-callback'?: () => void;
}

export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | undefined;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | undefined;

/**
 * Loads api.js once per page. The script element is created by our (nonce-trusted) bundle, which
 * `'strict-dynamic'` allows; a failed load is forgotten so "다시 하기" can try again.
 */
export function loadTurnstile(doc: Document = document): Promise<TurnstileApi> {
  const win = doc.defaultView;
  if (win?.turnstile) return Promise.resolve(win.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    const fail = () => {
      script.remove();
      loading = undefined;
      reject(new Error('Turnstile script could not be loaded'));
    };
    script.addEventListener('load', () => {
      if (win?.turnstile) resolve(win.turnstile);
      else fail();
    });
    script.addEventListener('error', fail);
    doc.head.appendChild(script);
  });
  return loading;
}

/** Test seam: forget a cached loader (Vitest swaps `window.turnstile`). */
export function resetTurnstileLoaderForTests(): void {
  loading = undefined;
}
