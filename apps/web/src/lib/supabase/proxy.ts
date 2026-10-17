// Session refresh + route protection for `src/proxy.ts` (Next 16). The client reads cookies from
// the incoming request and writes refreshed ones to both the forwarded request and the response,
// as @supabase/ssr requires; redirects carry the same cookies and no-store headers.
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { getPublicEnv } from '@/env';
import { decideAccess } from '@/lib/auth/routes';

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const { supabaseUrl, supabasePublishableKey } = getPublicEnv();
  let response = NextResponse.next({ request });
  const cacheHeaders: Record<string, string> = {};

  const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        Object.assign(cacheHeaders, headers);
        for (const [key, value] of Object.entries(cacheHeaders)) response.headers.set(key, value);
      },
    },
  });

  // Verifies the access token (refreshing it first when expired); cookie presence alone never
  // counts as signed in.
  const { data, error } = await supabase.auth.getClaims();
  const authenticated = !error && !!data?.claims?.sub;

  const decision = decideAccess({
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    authenticated,
  });
  if (decision.action === 'continue') return response;

  // Next's proxy adapter turns a same-origin Location into a relative one, so the browser stays on
  // the host it used (request.url itself reports 127.0.0.1 as localhost).
  const redirect = NextResponse.redirect(new URL(decision.location, request.nextUrl));
  for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
  for (const [key, value] of Object.entries(cacheHeaders)) redirect.headers.set(key, value);
  redirect.headers.set('Cache-Control', 'private, no-store');
  return redirect;
}
