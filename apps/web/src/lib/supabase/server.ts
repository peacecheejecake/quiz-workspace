// Supabase client for Server Components, Server Actions and Route Handlers. One client per request;
// it reads the session from the request cookies and writes refreshed/cleared cookies back where
// Next allows it (actions, route handlers). Authentication decisions use `getVerifiedUser()`
// (`getClaims()`), never `getSession().user` (docs/auth.md §3).
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { getPublicEnv } from '@/env';

export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const { supabaseUrl, supabasePublishableKey } = getPublicEnv();
  const cookieStore = await cookies();
  return createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies; the proxy already refreshed the session.
        }
      },
    },
  });
}

/** Verified identity of the current request (JWT signature checked against the project JWKS). */
export interface VerifiedUser {
  readonly id: string;
  readonly email: string | undefined;
}

export async function getVerifiedUser(client?: SupabaseClient): Promise<VerifiedUser | null> {
  const supabase = client ?? (await createSupabaseServerClient());
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;
  return { id: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined };
}
