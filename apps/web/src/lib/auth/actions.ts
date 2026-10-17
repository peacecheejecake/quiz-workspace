'use server';

// Server Actions for password sign-in and sign-out. Credentials go straight to Supabase Auth from
// the server; session cookies are written by the server client (HttpOnly handling stays in
// @supabase/ssr). Passwords and tokens are never logged or returned.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isSessionCookie } from '@/lib/supabase/session-guard';
import { LOGIN_PATH } from './routes';
import { safeNextPath } from './safe-next';
import { classifySignInError, SIGN_IN_MESSAGES } from './sign-in-errors';

export interface SignInState {
  readonly error?: string;
  /** Echoed back so the form keeps the address after a failed attempt (never the password). */
  readonly email?: string;
}

export async function signInAction(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const next = safeNextPath(formData.get('next'));
  if (!email || !password) return { error: SIGN_IN_MESSAGES.required, email };

  let failure: SignInState | undefined;
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) failure = { error: SIGN_IN_MESSAGES[classifySignInError(error)], email };
  } catch {
    failure = { error: SIGN_IN_MESSAGES.unavailable, email };
  }
  if (failure) return failure;
  redirect(next);
}

/** Ends this browser's session: revokes its refresh token at the Auth server, clears cookies. */
export async function signOutAction(): Promise<void> {
  let failed: boolean;
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    failed = !!error;
  } catch {
    // Unreadable session cookie.
    failed = true;
  }
  if (failed) {
    // Auth server unreachable or corrupt cookie: still drop this browser's session cookies so the
    // user is signed out locally (the refresh token then expires on its own).
    const cookieStore = await cookies();
    for (const { name } of cookieStore.getAll()) {
      if (isSessionCookie(name)) cookieStore.delete(name);
    }
  }
  redirect(LOGIN_PATH);
}
