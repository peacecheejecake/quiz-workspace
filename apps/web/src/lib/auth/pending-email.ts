// Address awaiting confirmation, handed from `/signup` to `/auth/verify` (AUTH-02 → AUTH-03) in a
// short-lived cookie scoped to `/auth/verify`, so the email never appears in a URL. The verify page
// reads it on the server, which keeps its first render deterministic. Not a credential: anyone may
// ask Auth to resend a confirmation for any address.
import { normalizeEmail, validateEmail } from './validation';

export const PENDING_EMAIL_COOKIE = 'qz_verify_email';
export const PENDING_EMAIL_PATH = '/auth/verify';
export const PENDING_EMAIL_MAX_AGE = 60 * 60;

/** `document.cookie` assignment that stores the address (browser only). */
export function pendingEmailCookie(email: string, secure: boolean): string {
  return [
    `${PENDING_EMAIL_COOKIE}=${encodeURIComponent(email)}`,
    `Path=${PENDING_EMAIL_PATH}`,
    `Max-Age=${PENDING_EMAIL_MAX_AGE}`,
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** Cookie value → address, or undefined when absent or not an email. */
export function parsePendingEmail(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let value: string;
  try {
    value = normalizeEmail(decodeURIComponent(raw));
  } catch {
    return undefined;
  }
  return validateEmail(value) ? undefined : value;
}
