'use server';

// Server Actions for password sign-in and sign-out. Credentials go straight to Supabase Auth from
// the server; session cookies are written by the server client (HttpOnly handling stays in
// @supabase/ssr). Passwords and tokens are never logged or returned.
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { turnstileSiteKey } from '@/env';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { CAPTCHA_FIELD } from './captcha';
import { endBrowserSession } from './end-session';
import { PENDING_EMAIL_COOKIE, pendingEmailCookieOptions } from './pending-email';
import { LOGIN_PATH } from './routes';
import { safeNextPath } from './safe-next';
import { classifySignInError, SIGN_IN_MESSAGES } from './sign-in-errors';

export interface SignInState {
  readonly error?: string;
  /** Echoed back so the form keeps the address after a failed attempt (never the password). */
  readonly email?: string;
  /** Correct password but unconfirmed address: the form offers the verification screen. */
  readonly emailNotConfirmed?: boolean;
}

export async function signInAction(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const next = safeNextPath(formData.get('next'));
  if (!email || !password) return { error: SIGN_IN_MESSAGES.required, email };
  // CAPTCHA on (docs/auth.md §5.1): Auth would refuse a call without a token; never send one.
  const captchaToken = String(formData.get(CAPTCHA_FIELD) ?? '').trim() || undefined;
  if (turnstileSiteKey() !== undefined && !captchaToken) {
    return { error: SIGN_IN_MESSAGES.captchaRequired, email };
  }

  let failure: SignInState | undefined;
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
      ...(captchaToken ? { options: { captchaToken } } : {}),
    });
    if (error) {
      const kind = classifySignInError(error);
      if (kind === 'emailNotConfirmed') {
        // Hand this address to /auth/verify so "resend" targets it, not an older pending one.
        // Only reachable with the correct password, so it reveals nothing about other accounts.
        const secure = (await headers()).get('origin')?.startsWith('https:') ?? false;
        (await cookies()).set(PENDING_EMAIL_COOKIE, email, pendingEmailCookieOptions(secure));
      }
      failure = {
        error: SIGN_IN_MESSAGES[kind],
        email,
        ...(kind === 'emailNotConfirmed' ? { emailNotConfirmed: true } : {}),
      };
    }
  } catch {
    failure = { error: SIGN_IN_MESSAGES.unavailable, email };
  }
  if (failure) return failure;
  redirect(next);
}

/** Ends this browser's session: revokes its refresh token at the Auth server, clears cookies. */
export async function signOutAction(): Promise<void> {
  await endBrowserSession();
  redirect(LOGIN_PATH);
}
