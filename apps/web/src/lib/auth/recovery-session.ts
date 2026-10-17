// Server-side read of the recovery-session gate (see recovery.ts): verified claims via
// getClaims() plus the HttpOnly marker cookie. Used by the `/reset-password` page and, again, by
// its server action right before the password is changed.
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { readVerifiedClaims } from '@/lib/supabase/session-guard';
import { isRecoverySession, RECOVERY_COOKIE } from './recovery';

export async function hasRecoverySession(supabase: SupabaseClient): Promise<boolean> {
  const marker = (await cookies()).get(RECOVERY_COOKIE)?.value;
  if (!marker) return false;
  const { claims } = await readVerifiedClaims(supabase);
  return isRecoverySession({ claims, marker, now: Math.floor(Date.now() / 1000) });
}
