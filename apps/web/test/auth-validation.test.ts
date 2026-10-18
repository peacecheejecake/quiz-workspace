import { describe, expect, it } from 'vitest';
import {
  classifyMailRequestError,
  classifySignUpError,
  FLOW_MESSAGES,
  retryAfterSeconds,
} from '../src/lib/auth/flow-errors';
import { parsePendingEmail, pendingEmailCookie } from '../src/lib/auth/pending-email';
import { classifyPasswordUpdateError, RESET_MESSAGES } from '../src/lib/auth/reset-errors';
import {
  hasErrors,
  validateEmail,
  validateNewPassword,
  validatePasswordReset,
  validateSignIn,
  validateSignUp,
  VALIDATION_MESSAGES,
} from '../src/lib/auth/validation';

describe('password policy (min 10, no composition rules)', () => {
  it('rejects fewer than 10 characters and accepts 10 of any kind', () => {
    expect(validateNewPassword('')).toBe(VALIDATION_MESSAGES.passwordRequired);
    expect(validateNewPassword('short-9ch')).toBe(VALIDATION_MESSAGES.passwordTooShort);
    expect(validateNewPassword('aaaaaaaaaa')).toBeUndefined();
    expect(validateNewPassword('0123456789')).toBeUndefined();
    expect(VALIDATION_MESSAGES.passwordTooShort).toMatch(/10\s*자/);
  });

  it('counts characters, not UTF-16 units, and caps the byte length bcrypt accepts', () => {
    expect(validateNewPassword('비밀번호비밀번호비밀')).toBeUndefined();
    expect(validateNewPassword('😀'.repeat(9))).toBe(VALIDATION_MESSAGES.passwordTooShort);
    expect(validateNewPassword('a'.repeat(72))).toBeUndefined();
    expect(validateNewPassword('a'.repeat(73))).toBe(VALIDATION_MESSAGES.passwordTooLong);
  });
});

describe('email shape', () => {
  it.each(['', 'not-an-email', 'a@b', 'a b@example.com', '@example.com', 'a@.com'])(
    'rejects %j',
    (value) => expect(validateEmail(value)).toBeDefined(),
  );
  it.each(['a@example.com', 'e2e-x+tag@example.test', '이름@example.kr'])('accepts %j', (value) =>
    expect(validateEmail(value)).toBeUndefined(),
  );
  it('uses a message the forgot-password screen can show as a field error', () => {
    expect(VALIDATION_MESSAGES.emailInvalid).toMatch(/이메일 (형식|주소)/);
  });
});

describe('form validators', () => {
  it('sign-up reports every invalid field at once', () => {
    const errors = validateSignUp({ email: 'x', password: 'short', confirm: 'other' });
    expect(Object.keys(errors).sort()).toEqual(['confirm', 'email', 'password']);
    expect(errors.confirm).toBe(VALIDATION_MESSAGES.confirmMismatch);
  });

  it('sign-up and reset accept matching valid input', () => {
    const password = 'long-enough-1';
    expect(hasErrors(validateSignUp({ email: 'a@example.com', password, confirm: password }))).toBe(
      false,
    );
    expect(hasErrors(validatePasswordReset({ password, confirm: password }))).toBe(false);
  });

  it('reset flags only the confirmation when it differs', () => {
    expect(validatePasswordReset({ password: 'long-enough-1', confirm: 'long-enough-2' })).toEqual({
      confirm: VALIDATION_MESSAGES.confirmMismatch,
    });
  });

  it('sign-in does not apply the length policy to existing passwords', () => {
    expect(validateSignIn({ email: 'a@example.com', password: 'short' })).toEqual({});
    expect(validateSignIn({ email: '', password: '' })).toEqual({
      email: VALIDATION_MESSAGES.emailRequired,
      password: VALIDATION_MESSAGES.passwordRequired,
    });
  });
});

describe('browser Auth flow errors', () => {
  it('treats account-existence errors on sign-up as success', () => {
    for (const code of ['user_already_exists', 'email_exists']) {
      expect(classifySignUpError({ code, status: 422 })).toBe('ok');
    }
  });

  it('maps throttling and outages to generic retry notices', () => {
    expect(classifySignUpError({ code: 'over_request_rate_limit', status: 429 })).toBe(
      'rateLimited',
    );
    expect(classifyMailRequestError({ code: 'over_email_send_rate_limit', status: 429 })).toBe(
      'rateLimited',
    );
    expect(classifyMailRequestError({ code: 'unexpected_failure', status: 500 })).toBe(
      'unavailable',
    );
    expect(classifyMailRequestError({ name: 'AuthRetryableFetchError', status: 0 })).toBe(
      'unavailable',
    );
    for (const message of Object.values(FLOW_MESSAGES)) {
      expect(message).toMatch(/잠시 후|다시 시도/);
      expect(message).not.toMatch(/429|rate limit|이미 (가입|등록)|존재/i);
    }
  });

  it('never distinguishes unknown addresses on mail requests', () => {
    expect(classifyMailRequestError({ code: 'user_not_found', status: 404 })).toBe('ok');
    expect(classifyMailRequestError({ status: 400 })).toBe('ok');
  });

  it('reports field-fixable sign-up errors', () => {
    expect(classifySignUpError({ code: 'weak_password', status: 422 })).toBe('weakPassword');
    expect(classifySignUpError({ code: 'email_address_invalid', status: 400 })).toBe(
      'invalidEmail',
    );
    expect(classifySignUpError({ code: 'signup_disabled', status: 422 })).toBe('signupDisabled');
  });

  it('reads the per-user mail delay only from throttling errors', () => {
    const msg = 'For security purposes, you can only request this after 1 seconds.';
    expect(retryAfterSeconds({ status: 429, message: msg })).toBe(1);
    expect(retryAfterSeconds({ status: 429, message: 'Email rate limit exceeded' })).toBe(
      undefined,
    );
    expect(retryAfterSeconds({ status: 400, message: msg })).toBe(undefined);
  });
});

describe('password update errors', () => {
  it('sends missing/expired sessions to the new-link offer', () => {
    expect(classifyPasswordUpdateError({ name: 'AuthSessionMissingError', status: 400 })).toBe(
      'expired',
    );
    expect(classifyPasswordUpdateError({ code: 'session_not_found', status: 403 })).toBe('expired');
  });

  it('keeps policy errors on the field and hides raw codes', () => {
    expect(classifyPasswordUpdateError({ code: 'same_password', status: 422 })).toBe(
      'samePassword',
    );
    expect(classifyPasswordUpdateError({ code: 'weak_password', status: 422 })).toBe(
      'weakPassword',
    );
    expect(classifyPasswordUpdateError({ status: 503 })).toBe('unavailable');
    for (const message of Object.values(RESET_MESSAGES)) {
      expect(message).not.toMatch(/same_password|weak_password|AuthApiError/);
    }
  });
});

describe('pending verification email cookie', () => {
  it('is scoped to /auth/verify, short-lived and never carries anything but the address', () => {
    const cookie = pendingEmailCookie('a+b@example.com', true);
    expect(cookie).toBe(
      'qz_verify_email=a%2Bb%40example.com; Path=/auth/verify; Max-Age=3600; SameSite=Lax; Secure',
    );
    expect(pendingEmailCookie('a@example.com', false)).not.toContain('Secure');
  });

  it('parses only well-formed addresses', () => {
    expect(parsePendingEmail('a%2Bb%40example.com')).toBe('a+b@example.com');
    expect(parsePendingEmail('a@example.com')).toBe('a@example.com');
    expect(parsePendingEmail('<script>')).toBeUndefined();
    expect(parsePendingEmail('%E0%A4%A')).toBeUndefined();
    expect(parsePendingEmail(undefined)).toBeUndefined();
  });
});
