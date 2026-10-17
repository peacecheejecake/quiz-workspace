// `/auth/callback` branching (AUTH-04, implementation-plan §7): mail links carry `token_hash` +
// `type` (verifyOtp), OAuth/PKCE carries `code` (exchangeCodeForSession). Pure helpers only; the
// route handler performs the Supabase calls. Nothing here ever puts a token into a URL.
import type { EmailOtpType } from '@supabase/supabase-js';
import { AUTH_ERROR_PATH, RESET_PASSWORD_PATH } from './routes';
import { DEFAULT_AFTER_SIGN_IN, safeNextPath } from './safe-next';

/** Reason codes `/auth/error` understands (`?reason=`). Never raw Auth error codes. */
export const AUTH_ERROR_REASONS = ['expired', 'invalid', 'missing', 'unavailable'] as const;
export type AuthErrorReason = (typeof AUTH_ERROR_REASONS)[number];

/** Which mail flow failed, so the error screen can offer the matching retry. */
export const AUTH_ERROR_FLOWS = ['signup', 'recovery', 'email_change', 'magiclink'] as const;
export type AuthErrorFlow = (typeof AUTH_ERROR_FLOWS)[number];

const EMAIL_OTP_TYPES: readonly EmailOtpType[] = [
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
];

export type CallbackPlan =
  | {
      readonly kind: 'verify-otp';
      readonly tokenHash: string;
      readonly type: EmailOtpType;
      readonly successPath: string;
    }
  | { readonly kind: 'exchange-code'; readonly code: string; readonly successPath: string }
  | { readonly kind: 'fail'; readonly reason: AuthErrorReason; readonly flow?: AuthErrorFlow };

function flowOf(type: string | null): AuthErrorFlow | undefined {
  switch (type) {
    case 'signup':
    case 'email':
    case 'invite':
      return 'signup';
    case 'recovery':
      return 'recovery';
    case 'email_change':
      return 'email_change';
    case 'magiclink':
      return 'magiclink';
    default:
      return undefined;
  }
}

/** Where a successful exchange lands: recovery always goes to `/reset-password`. */
export function successPathFor(type: EmailOtpType | null, next: string | null): string {
  if (type === 'recovery') return RESET_PASSWORD_PATH;
  return safeNextPath(next, DEFAULT_AFTER_SIGN_IN);
}

/** Decides what `/auth/callback` does with its query parameters. */
export function planCallback(params: URLSearchParams): CallbackPlan {
  const next = params.get('next');
  const rawType = params.get('type');
  const flow = flowOf(rawType);

  // Provider-side failure forwarded as query parameters (OAuth / implicit redirects).
  if (params.has('error') || params.has('error_code')) {
    const code = params.get('error_code') ?? params.get('error') ?? '';
    return withFlow({ kind: 'fail', reason: /expired/i.test(code) ? 'expired' : 'invalid' }, flow);
  }

  const tokenHash = params.get('token_hash')?.trim();
  if (tokenHash) {
    const type = EMAIL_OTP_TYPES.find((t) => t === rawType);
    if (!type) return withFlow({ kind: 'fail', reason: 'invalid' }, flow);
    return { kind: 'verify-otp', tokenHash, type, successPath: successPathFor(type, next) };
  }

  const code = params.get('code')?.trim();
  if (code) {
    return { kind: 'exchange-code', code, successPath: successPathFor(null, next) };
  }
  return withFlow({ kind: 'fail', reason: 'missing' }, flow);
}

function withFlow(
  plan: { kind: 'fail'; reason: AuthErrorReason },
  flow: AuthErrorFlow | undefined,
): CallbackPlan {
  return flow ? { ...plan, flow } : plan;
}

/** Shape of the Supabase `AuthError` fields we classify on (never echoed to the user). */
export interface AuthErrorLike {
  readonly code?: string | undefined;
  readonly status?: number | undefined;
  readonly name?: string | undefined;
}

/** Maps a verifyOtp / exchangeCodeForSession failure to a user-facing reason code. */
export function classifyCallbackError(error: AuthErrorLike): AuthErrorReason {
  if (error.name === 'AuthRetryableFetchError' || (error.status ?? 0) >= 500) return 'unavailable';
  if (error.code === 'otp_expired' || error.code === 'flow_state_expired') return 'expired';
  return 'invalid';
}

/** `/auth/error?reason=…[&flow=…]` — only reason codes, never the token or the raw Auth error. */
export function authErrorPath(reason: AuthErrorReason, flow?: AuthErrorFlow): string {
  const query = new URLSearchParams({ reason });
  if (flow) query.set('flow', flow);
  return `${AUTH_ERROR_PATH}?${query.toString()}`;
}

/** Redirect target after verifyOtp / exchangeCodeForSession: success path or the error screen. */
export function callbackResultPath(
  plan: Exclude<CallbackPlan, { kind: 'fail' }>,
  error: AuthErrorLike | null,
): string {
  if (!error) return plan.successPath;
  return authErrorPath(
    classifyCallbackError(error),
    plan.kind === 'verify-otp' ? flowOf(plan.type) : undefined,
  );
}

export function parseAuthErrorReason(value: unknown): AuthErrorReason | undefined {
  return AUTH_ERROR_REASONS.find((r) => r === value);
}

export function parseAuthErrorFlow(value: unknown): AuthErrorFlow | undefined {
  return AUTH_ERROR_FLOWS.find((f) => f === value);
}
