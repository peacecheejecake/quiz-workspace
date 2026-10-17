// User-facing sign-in error copy (docs/auth.md §5): one generic credentials message whether the
// account exists or not; raw Auth error codes are never shown.
import type { AuthErrorLike } from './callback';

export const SIGN_IN_MESSAGES = {
  credentials: '이메일 또는 비밀번호가 올바르지 않습니다. 다시 확인해 주세요.',
  required: '이메일과 비밀번호를 입력해 주세요.',
  emailNotConfirmed:
    '이메일 인증이 아직 완료되지 않았습니다. 받은 편지함의 인증 메일을 확인해 주세요.',
  rateLimited: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  unavailable: '일시적으로 로그인할 수 없습니다. 잠시 후 다시 시도해 주세요.',
} as const;

export type SignInErrorKind = keyof typeof SIGN_IN_MESSAGES;

/**
 * `email_not_confirmed` is only returned for a correct password, so naming it does not reveal
 * whether an address is registered. Everything else that is not an outage is "credentials".
 */
export function classifySignInError(error: AuthErrorLike): SignInErrorKind {
  if (error.name === 'AuthRetryableFetchError' || (error.status ?? 0) >= 500) return 'unavailable';
  if (error.status === 429 || error.code === 'over_request_rate_limit') return 'rateLimited';
  if (error.code === 'email_not_confirmed') return 'emailNotConfirmed';
  return 'credentials';
}
