// "AUTH-04" 인증 콜백 (`/auth/callback`): redeems a mail `token_hash` (verifyOtp) or an
// OAuth/PKCE `code` (exchangeCodeForSession), then redirects to the validated `next` (recovery →
// `/reset-password`) or to `/auth/error?reason=…`. The token never appears in a redirect URL or log.
import { createServerClient } from '@supabase/ssr';
import type { NextRequest, NextResponse } from 'next/server';
import { getPublicEnv } from '@/env';
import {
  authErrorPath,
  callbackResultPath,
  planCallback,
  type AuthErrorLike,
} from '@/lib/auth/callback';
import { relativeRedirect } from '@/lib/http/redirect';

export const dynamic = 'force-dynamic';

interface PendingCookie {
  name: string;
  value: string;
  options: Parameters<NextResponse['cookies']['set']>[2];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const plan = planCallback(request.nextUrl.searchParams);
  const pending: PendingCookie[] = [];
  const cacheHeaders: Record<string, string> = {};

  let location: string;
  if (plan.kind === 'fail') {
    location = authErrorPath(plan.reason, plan.flow);
  } else {
    const { supabaseUrl, supabasePublishableKey } = getPublicEnv();
    const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet, headers) => {
          pending.push(...cookiesToSet);
          Object.assign(cacheHeaders, headers);
        },
      },
    });
    let error: AuthErrorLike | null;
    try {
      ({ error } =
        plan.kind === 'verify-otp'
          ? await supabase.auth.verifyOtp({ token_hash: plan.tokenHash, type: plan.type })
          : await supabase.auth.exchangeCodeForSession(plan.code));
    } catch {
      // The SDK threw (e.g. a malformed existing session cookie): no session was created.
      error = { code: 'unexpected_failure' };
      pending.length = 0;
    }
    location = callbackResultPath(plan, error);
  }

  const response = relativeRedirect(location, 303);
  for (const { name, value, options } of pending) response.cookies.set(name, value, options);
  for (const [key, value] of Object.entries(cacheHeaders)) response.headers.set(key, value);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
