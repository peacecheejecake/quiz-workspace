import { NextResponse, type NextRequest } from 'next/server';
import { getPublicEnv } from '@/env';
import {
  buildContentSecurityPolicy,
  createNonce,
  HSTS_VALUE,
  isCrossOriginWrite,
  isHttpsRequest,
  NONCE_HEADER,
} from '@/lib/http/security-headers';
import { updateSession } from '@/lib/supabase/proxy';

export async function proxy(request: NextRequest) {
  // Cross-site form posts / fetches never reach a Server Action or route handler (docs/auth.md §5).
  if (isCrossOriginWrite(request.method, request.headers)) {
    return new NextResponse('Cross-origin request rejected', {
      status: 403,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const https = isHttpsRequest(request.headers, request.nextUrl);
  const { supabaseUrl, apiBaseUrl } = getPublicEnv();
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    connectOrigins: [supabaseUrl, apiBaseUrl],
    dev: process.env.NODE_ENV === 'development',
    https,
  });
  // Next reads the nonce from the request's CSP header and stamps it on its own <script> tags;
  // `updateSession` forwards these request headers to the render.
  request.headers.set(NONCE_HEADER, nonce);
  request.headers.set('Content-Security-Policy', csp);

  const response = await updateSession(request);
  response.headers.set('Content-Security-Policy', csp);
  if (https) response.headers.set('Strict-Transport-Security', HSTS_VALUE);
  return response;
}

export const config = {
  // Everything except build assets and static files: every page needs the session refreshed and
  // its own CSP nonce.
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|woff2?)$).*)',
  ],
};
