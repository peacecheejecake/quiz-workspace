'use server';

// AUTH-06 new-password server action. The recovery-session gate is re-checked here (not only when
// the page rendered), the policy is re-validated, and only then is the password changed. The
// password is never logged, echoed back or put into a URL.
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { classifyPasswordUpdateError, RESET_MESSAGES } from './reset-errors';
import { RECOVERY_COOKIE, RECOVERY_COOKIE_PATH } from './recovery';
import { hasRecoverySession } from './recovery-session';
import { hasErrors, validatePasswordReset, type FieldErrors } from './validation';

export interface ResetPasswordState {
  /** `expired`: no (longer a) valid recovery session — the screen offers a new link instead. */
  readonly status: 'idle' | 'error' | 'expired' | 'done';
  readonly error?: string;
  readonly fieldErrors?: FieldErrors<'password' | 'confirm'>;
}

export async function updatePasswordAction(
  _prev: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  const fieldErrors = validatePasswordReset({ password, confirm });
  if (hasErrors(fieldErrors)) return { status: 'error', fieldErrors };

  try {
    const supabase = await createSupabaseServerClient();
    if (!(await hasRecoverySession(supabase))) return { status: 'expired' };

    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      const kind = classifyPasswordUpdateError(error);
      if (kind === 'expired') return { status: 'expired' };
      if (kind === 'weakPassword' || kind === 'samePassword') {
        return { status: 'error', fieldErrors: { password: RESET_MESSAGES[kind] } };
      }
      return { status: 'error', error: RESET_MESSAGES[kind] };
    }

    // One reset per recovery link: drop the marker so the form is not offered again, and end the
    // account's other sessions (the old password may have been compromised). This browser keeps
    // its session. A failure here does not undo the successful change.
    (await cookies()).delete({ name: RECOVERY_COOKIE, path: RECOVERY_COOKIE_PATH });
    try {
      await supabase.auth.signOut({ scope: 'others' });
    } catch {
      // Best effort.
    }
    return { status: 'done' };
  } catch {
    return { status: 'error', error: RESET_MESSAGES.unavailable };
  }
}
