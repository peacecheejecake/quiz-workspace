// Flags for every Supabase session cookie the server writes (docs/auth.md §5): HttpOnly (the
// browser client only calls signUp/resend/resetPasswordForEmail, none of which reads the session),
// SameSite=Lax (top-level navigations from email links still carry it; cross-site POSTs do not),
// Secure whenever the site is served over HTTPS. Applied in `setAll`, so refreshes, sign-in and
// sign-out (maxAge 0) all agree.
import type { CookieOptions } from '@supabase/ssr';

export function hardenSessionCookie(
  options: CookieOptions | undefined,
  secure: boolean,
): CookieOptions {
  return { path: '/', ...options, httpOnly: true, sameSite: 'lax', secure };
}
