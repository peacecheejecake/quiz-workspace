// Ends this browser's session from a server action: revokes its refresh token at the Auth server
// and clears the session cookies. Not a server action itself (no 'use server'): callers decide
// where to redirect afterwards.
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isSessionCookie } from '@/lib/supabase/session-guard';

export async function endBrowserSession(client?: SupabaseClient): Promise<void> {
  let failed: boolean;
  try {
    const supabase = client ?? (await createSupabaseServerClient());
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
}
