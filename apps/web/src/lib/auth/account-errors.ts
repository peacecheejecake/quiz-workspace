// User-facing copy for a failed password change on `/settings/security` (ACCOUNT-01). Reuses the
// AUTH-06 classification but separates the two session outcomes this screen handles differently:
// `reauthenticate` (Auth `secure_password_change`: the sign-in is older than 24h) offers a fresh
// sign-in, `signedOut` (no usable session) sends the browser to /login. Raw Auth codes are never
// shown.
import type { AuthErrorLike } from './callback';
import { classifyPasswordUpdateError, RESET_MESSAGES } from './reset-errors';

export const ACCOUNT_MESSAGES = {
  ...RESET_MESSAGES,
  reauthenticate:
    '보안을 위해 최근에 로그인한 세션에서만 비밀번호를 바꿀 수 있습니다. 다시 로그인한 뒤 시도해 주세요.',
} as const;

export type AccountPasswordErrorKind =
  'reauthenticate' | 'signedOut' | 'weakPassword' | 'samePassword' | 'rateLimited' | 'unavailable';

export function classifyAccountPasswordError(error: AuthErrorLike): AccountPasswordErrorKind {
  if (error.code === 'reauthentication_needed' || error.code === 'reauthentication_not_valid') {
    return 'reauthenticate';
  }
  const kind = classifyPasswordUpdateError(error);
  return kind === 'expired' ? 'signedOut' : kind;
}
