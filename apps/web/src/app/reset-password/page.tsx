import { PasswordResetScreen } from '@/components/auth/password-reset-form';
import { stubMetadata } from '@/components/stub-screen';
import { hasRecoverySession } from '@/lib/auth/recovery-session';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = stubMetadata('AUTH-06');
export const dynamic = 'force-dynamic';

// Only a recovery session (recovery link redeemed by /auth/callback, see lib/auth/recovery.ts)
// gets the new-password form; anything else, including a normal signed-in session, is offered a
// new recovery link instead (AUTH-06-AC02).
export default async function Page() {
  const allowed = await hasRecoverySession(await createSupabaseServerClient());
  return <PasswordResetScreen screenId="AUTH-06" allowed={allowed} />;
}
