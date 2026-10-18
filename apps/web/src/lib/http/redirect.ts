import { NextResponse } from 'next/server';

/**
 * Route-handler redirect with a relative `Location` (RFC 9110 §10.2.2). `NextResponse.redirect`
 * needs an absolute URL, and `request.url` reports `127.0.0.1` as `localhost`, which would move
 * the browser to another cookie host. Not for `proxy.ts`: its adapter requires absolute URLs (and
 * relativizes same-origin ones itself). Callers pass only validated internal paths.
 */
export function relativeRedirect(location: string, status: 303 | 307 = 307): NextResponse {
  if (!location.startsWith('/') || location.startsWith('//') || location.includes('\\')) {
    throw new Error('relativeRedirect only accepts internal paths');
  }
  return new NextResponse(null, { status, headers: { Location: location } });
}
