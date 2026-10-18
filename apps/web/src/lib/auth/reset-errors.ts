// User-facing copy for a failed password update on `/reset-password` (AUTH-06). Raw Auth codes
// are never shown.
import type { AuthErrorLike } from './callback';
import { PASSWORD_MIN_LENGTH } from './validation';

export const RESET_MESSAGES = {
  weakPassword: `추측하기 어려운 다른 비밀번호를 입력해 주세요. (${PASSWORD_MIN_LENGTH}자 이상)`,
  samePassword: '새 비밀번호는 이전 비밀번호와 달라야 합니다.',
  rateLimited: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  unavailable: '일시적인 문제로 비밀번호를 변경하지 못했습니다. 잠시 후 다시 시도해 주세요.',
} as const;

export type PasswordUpdateErrorKind = keyof typeof RESET_MESSAGES | 'expired';

const SESSION_CODES = new Set([
  'session_not_found',
  'session_expired',
  'refresh_token_not_found',
  'refresh_token_already_used',
  'bad_jwt',
  'no_authorization',
  'user_not_found',
  'reauthentication_needed',
]);

export function classifyPasswordUpdateError(error: AuthErrorLike): PasswordUpdateErrorKind {
  if (error.name === 'AuthSessionMissingError') return 'expired';
  if (error.status === 429 || error.code === 'over_request_rate_limit') return 'rateLimited';
  if (error.name === 'AuthRetryableFetchError' || (error.status ?? 0) >= 500) return 'unavailable';
  if (error.code === 'same_password') return 'samePassword';
  if (error.code === 'weak_password') return 'weakPassword';
  if (SESSION_CODES.has(error.code ?? '') || error.status === 401 || error.status === 403) {
    return 'expired';
  }
  return 'unavailable';
}
