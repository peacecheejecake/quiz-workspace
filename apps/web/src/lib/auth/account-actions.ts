'use server';

// ACCOUNT-01 server actions: change the password of the signed-in account, and the "sign in again"
// step Auth's `secure_password_change` asks for when the session's sign-in is older than 24h.
// This is not the AUTH-06 recovery flow: any verified session may change its own password here.
// The password is never logged, echoed back or put into a URL.
import { redirect } from 'next/navigation';
import { createSupabaseServerClient, getVerifiedUser } from '@/lib/supabase/server';
import { ACCOUNT_MESSAGES, classifyAccountPasswordError } from './account-errors';
import { endBrowserSession } from './end-session';
import { ACCOUNT_SECURITY_PATH, loginRedirectPath } from './routes';
import { hasErrors, validatePasswordReset, type FieldErrors } from './validation';

export interface ChangePasswordState {
  /** `reauthenticate`: Auth wants a recent sign-in; the screen offers "다시 로그인". */
  readonly status: 'idle' | 'error' | 'reauthenticate' | 'done';
  readonly error?: string;
  readonly fieldErrors?: FieldErrors<'password' | 'confirm'>;
}

export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  const fieldErrors = validatePasswordReset({ password, confirm });
  if (hasErrors(fieldErrors)) return { status: 'error', fieldErrors };

  let outcome: ChangePasswordState | 'signedOut';
  try {
    outcome = await changePassword(password);
  } catch {
    outcome = { status: 'error', error: ACCOUNT_MESSAGES.unavailable };
  }
  // redirect() throws, so it stays outside the try block.
  if (outcome === 'signedOut') redirect(loginRedirectPath(ACCOUNT_SECURITY_PATH));
  return outcome;
}

async function changePassword(password: string): Promise<ChangePasswordState | 'signedOut'> {
  const supabase = await createSupabaseServerClient();
  if (!(await getVerifiedUser(supabase))) return 'signedOut';

  const { error } = await supabase.auth.updateUser({ password });
  if (!error) {
    // The old password may have been compromised: end the account's other sessions. This
    // browser keeps its session. A failure here does not undo the successful change.
    try {
      await supabase.auth.signOut({ scope: 'others' });
    } catch {
      // Best effort.
    }
    return { status: 'done' };
  }

  const kind = classifyAccountPasswordError(error);
  switch (kind) {
    case 'reauthenticate':
      return { status: 'reauthenticate', error: ACCOUNT_MESSAGES.reauthenticate };
    case 'weakPassword':
    case 'samePassword':
      return { status: 'error', fieldErrors: { password: ACCOUNT_MESSAGES[kind] } };
    case 'signedOut':
      // The JWT still verifies but Auth no longer knows the session: drop it locally so the
      // login page does not bounce the browser straight back here.
      await endBrowserSession(supabase);
      return 'signedOut';
    default:
      return { status: 'error', error: ACCOUNT_MESSAGES[kind] };
  }
}

/** Signs this browser out and returns to this screen through /login (fresh sign-in). */
export async function reauthenticateAction(): Promise<void> {
  await endBrowserSession();
  redirect(loginRedirectPath(ACCOUNT_SECURITY_PATH));
}
