// Server-side FastAPI client (docs/auth.md §3): attaches `Authorization: Bearer <access token>` of
// the current, JWT-verified session to @quiz/api-client calls. The token stays in this request's
// headers only — never in URLs, logs or props passed to client components.
import { createApiClient, type ApiClient } from '@quiz/api-client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { readVerifiedClaims } from '@/lib/supabase/session-guard';
import { getServerApiBaseUrl } from './base-url';

export class NotAuthenticatedError extends Error {
  constructor() {
    super('No verified session for the API call');
    this.name = 'NotAuthenticatedError';
  }
}

/** Authorization header for a Supabase access token. */
export function bearerHeaders(accessToken: string): { Authorization: string } {
  if (!accessToken || /\s/.test(accessToken)) throw new NotAuthenticatedError();
  return { Authorization: `Bearer ${accessToken}` };
}

/**
 * Access token of the current request, returned only after `getClaims()` verified it (the token
 * `getClaims()` checks is the session's own access token, refreshed first when expired).
 */
export async function verifiedAccessToken(supabase: SupabaseClient): Promise<string | null> {
  const { claims } = await readVerifiedClaims(supabase);
  if (!claims) return null;
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** API client authenticated as the current user; throws `NotAuthenticatedError` when signed out. */
export async function createServerApiClient(): Promise<ApiClient> {
  const supabase = await createSupabaseServerClient();
  const token = await verifiedAccessToken(supabase);
  if (!token) throw new NotAuthenticatedError();
  return createApiClient({
    baseUrl: getServerApiBaseUrl(),
    headers: bearerHeaders(token),
  });
}
