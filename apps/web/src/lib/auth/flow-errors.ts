// Error classification for the browser-side Auth calls (sign-up, verification resend, recovery
// request; implementation-plan §7). docs/auth.md §5: never reveal whether an account exists and
// never show raw Auth codes or messages — only these fixed Korean notices.
import { CAPTCHA_MESSAGES, isCaptchaError } from './captcha';
import type { AuthErrorLike } from './callback';

export const FLOW_MESSAGES = {
  rateLimited: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  unavailable: '일시적인 문제로 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  signupDisabled: '현재 새 계정을 만들 수 없습니다. 잠시 후 다시 시도해 주세요.',
  captchaFailed: CAPTCHA_MESSAGES.rejected,
} as const;

/**
 * - `ok`: treat as success (also used for account-existence errors, so an existing address looks
 *   exactly like a new one).
 * - `weakPassword` / `invalidEmail`: field errors the user can fix.
 * - `captchaFailed`: Auth refused the CAPTCHA token (docs/auth.md §5.1); a new check is needed.
 * - everything else: a generic retry notice.
 */
export type FlowErrorKind =
  | 'ok'
  | 'weakPassword'
  | 'invalidEmail'
  | 'rateLimited'
  | 'signupDisabled'
  | 'captchaFailed'
  | 'unavailable';

const EXISTENCE_CODES = new Set(['user_already_exists', 'email_exists', 'identity_already_exists']);
const RATE_LIMIT_CODES = new Set([
  'over_request_rate_limit',
  'over_email_send_rate_limit',
  'over_sms_send_rate_limit',
]);

function isRateLimit(error: AuthErrorLike): boolean {
  return error.status === 429 || RATE_LIMIT_CODES.has(error.code ?? '');
}

function isOutage(error: AuthErrorLike): boolean {
  return (
    error.name === 'AuthRetryableFetchError' ||
    (error.status ?? 0) >= 500 ||
    // Network failure before any HTTP status (fetch threw).
    error.status === 0
  );
}

export function classifySignUpError(error: AuthErrorLike): FlowErrorKind {
  if (isCaptchaError(error)) return 'captchaFailed';
  if (isRateLimit(error)) return 'rateLimited';
  if (isOutage(error)) return 'unavailable';
  if (EXISTENCE_CODES.has(error.code ?? '')) return 'ok';
  if (error.code === 'weak_password') return 'weakPassword';
  if (error.code === 'email_address_invalid' || error.code === 'validation_failed') {
    return 'invalidEmail';
  }
  if (error.code === 'signup_disabled' || error.code === 'email_provider_disabled') {
    return 'signupDisabled';
  }
  return 'unavailable';
}

/**
 * Recovery request and verification resend: only throttling and outages are reported; any other
 * 4xx (unknown address, already confirmed, …) reads as success so the response never depends on
 * whether the account exists (AUTH-05-AC01).
 */
export function classifyMailRequestError(error: AuthErrorLike): FlowErrorKind {
  // Checked first: a refused token is about this browser, not the account (no existence leak).
  if (isCaptchaError(error)) return 'captchaFailed';
  if (isRateLimit(error)) return 'rateLimited';
  if (isOutage(error)) return 'unavailable';
  if (error.code === 'email_address_invalid') return 'invalidEmail';
  return 'ok';
}

/**
 * Seconds Auth asks to wait before mailing the same user again (per-user `max_frequency`; GoTrue
 * says "…you can only request this after N seconds"). Undefined for other throttles, e.g. the
 * project-wide email quota, which come without a delay.
 */
export function retryAfterSeconds(error: AuthErrorLike & { readonly message?: string }) {
  if (!isRateLimit(error)) return undefined;
  const match = /after (\d+) seconds?/i.exec(error.message ?? '');
  return match ? Number(match[1]) : undefined;
}

/** A per-user throttle this short is waited out instead of being reported (one retry). */
export const SHORT_THROTTLE_SECONDS = 3;

export function flowMessage(kind: Exclude<FlowErrorKind, 'ok' | 'weakPassword' | 'invalidEmail'>) {
  return FLOW_MESSAGES[kind];
}
