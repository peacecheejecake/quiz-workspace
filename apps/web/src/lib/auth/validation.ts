// Client-side form validation for the auth screens (AUTH-01/02/05/06). Runs before any request so
// invalid input never reaches Supabase Auth (AUTH-02-AC02, AUTH-05-AC02, AUTH-06-AC03). The
// server (Auth `minimum_password_length = 10`, server actions) re-validates; this is UX, not a
// security boundary.

/** Password policy (implementation-plan §7): at least 10 characters, no composition rules. */
export const PASSWORD_MIN_LENGTH = 10;
/** Upper bound bcrypt (GoTrue) accepts; longer inputs are rejected rather than truncated. */
export const PASSWORD_MAX_LENGTH = 72;

export const VALIDATION_MESSAGES = {
  emailRequired: '이메일 주소를 입력해 주세요.',
  emailInvalid: '올바른 이메일 주소 형식으로 입력해 주세요. (예: name@example.com)',
  passwordRequired: '비밀번호를 입력해 주세요.',
  passwordTooShort: `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상이어야 합니다.`,
  passwordTooLong: `비밀번호는 ${PASSWORD_MAX_LENGTH}자 이하로 입력해 주세요.`,
  confirmRequired: '비밀번호를 한 번 더 입력해 주세요.',
  confirmMismatch: '비밀번호가 일치하지 않습니다.',
} as const;

/** Description shown under every new-password field. */
export const PASSWORD_HINT = `${PASSWORD_MIN_LENGTH}자 이상 입력하세요. 문자 종류 제한은 없습니다.`;

// Pragmatic shape check (local@domain.tld, no spaces); the Auth server is the real judge.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export function normalizeEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

export function validateEmail(email: string): string | undefined {
  if (!email) return VALIDATION_MESSAGES.emailRequired;
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) return VALIDATION_MESSAGES.emailInvalid;
  return undefined;
}

/** Policy check for a password being set (sign-up, reset, change). */
export function validateNewPassword(password: string): string | undefined {
  if (!password) return VALIDATION_MESSAGES.passwordRequired;
  if ([...password].length < PASSWORD_MIN_LENGTH) return VALIDATION_MESSAGES.passwordTooShort;
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_LENGTH) {
    return VALIDATION_MESSAGES.passwordTooLong;
  }
  return undefined;
}

export function validateConfirmation(password: string, confirm: string): string | undefined {
  if (!confirm) return VALIDATION_MESSAGES.confirmRequired;
  if (password !== confirm) return VALIDATION_MESSAGES.confirmMismatch;
  return undefined;
}

function compact<K extends string>(errors: Record<K, string | undefined>): FieldErrors<K> {
  const out: FieldErrors<K> = {};
  for (const [key, value] of Object.entries(errors) as [K, string | undefined][]) {
    if (value) out[key] = value;
  }
  return out;
}

export function validateSignIn(input: {
  email: string;
  password: string;
}): FieldErrors<'email' | 'password'> {
  return compact({
    email: validateEmail(input.email),
    // Sign-in never applies the length policy: older accounts may predate it.
    password: input.password ? undefined : VALIDATION_MESSAGES.passwordRequired,
  });
}

export function validateSignUp(input: {
  email: string;
  password: string;
  confirm: string;
}): FieldErrors<'email' | 'password' | 'confirm'> {
  return compact({
    email: validateEmail(input.email),
    password: validateNewPassword(input.password),
    confirm: validateConfirmation(input.password, input.confirm),
  });
}

export function validatePasswordReset(input: {
  password: string;
  confirm: string;
}): FieldErrors<'password' | 'confirm'> {
  return compact({
    password: validateNewPassword(input.password),
    confirm: validateConfirmation(input.password, input.confirm),
  });
}

export function hasErrors(errors: FieldErrors<string>): boolean {
  return Object.keys(errors).length > 0;
}
