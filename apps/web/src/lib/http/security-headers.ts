// Per-request security headers set by `src/proxy.ts` (docs/auth.md §5): a nonce-based CSP that
// Next.js applies to its own scripts, HSTS over HTTPS, and the cross-origin write guard that backs
// up Next's Server Action origin check for any non-GET request (route handlers included).
//
// style-src keeps 'unsafe-inline' on purpose: React and Radix server-render `style="…"`
// attributes (Popper positioning, CSS custom properties such as sizes), and a nonce cannot cover
// attributes. Style injection cannot run script, and script-src stays strict (nonce +
// 'strict-dynamic', no 'unsafe-inline').
//
// With the auth CAPTCHA on (docs/auth.md §5.1) exactly two directives widen, to the Turnstile
// origin only: script-src (CSP3 browsers ignore the host under 'strict-dynamic' and run api.js
// because our nonce-trusted bundle inserts it; the host is the CSP2 fallback) and frame-src (the
// widget iframe). connect-src stays as is (no pre-clearance).
import { TURNSTILE_ORIGIN } from '@/lib/auth/captcha';

export const NONCE_HEADER = 'x-nonce';
export const HSTS_VALUE = 'max-age=63072000; includeSubDomains';

/** 128-bit random nonce, base64 (Web Crypto: available in the proxy and Node runtimes). */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export interface CspOptions {
  readonly nonce: string;
  /** Origins the browser may fetch from besides 'self' (Supabase Auth, FastAPI). */
  readonly connectOrigins: readonly string[];
  /** `next dev` needs eval for React's dev tooling; never in production builds. */
  readonly dev?: boolean;
  readonly https?: boolean;
  /** Auth CAPTCHA (Cloudflare Turnstile) enabled for this build. */
  readonly captcha?: boolean;
}

function originOf(url: string): string | null {
  try {
    const { protocol, origin } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? origin : null;
  } catch {
    return null;
  }
}

export function buildContentSecurityPolicy({
  nonce,
  connectOrigins,
  dev = false,
  https = false,
  captcha = false,
}: CspOptions): string {
  const connect = [...new Set(connectOrigins.map(originOf).filter((o): o is string => o !== null))];
  const directives: [string, ...string[]][] = [
    ['default-src', "'self'"],
    [
      'script-src',
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(captcha ? [TURNSTILE_ORIGIN] : []),
      ...(dev ? ["'unsafe-eval'"] : []),
    ],
    ['style-src', "'self'", "'unsafe-inline'"],
    ['img-src', "'self'", 'data:', 'blob:'],
    ['font-src', "'self'", 'data:'],
    ['connect-src', "'self'", ...connect],
    // Same-origin dedicated workers (DOC-01 file hashing). Without it workers fall back to
    // script-src, where 'strict-dynamic' ignores 'self' and blocks them.
    ['worker-src', "'self'"],
    ['frame-src', captcha ? TURNSTILE_ORIGIN : "'none'"],
    ['frame-ancestors', "'none'"],
    ['base-uri', "'self'"],
    ['object-src', "'none'"],
    ['form-action', "'self'"],
    ...(https ? [['upgrade-insecure-requests'] as [string]] : []),
  ];
  return directives.map((d) => d.join(' ')).join('; ');
}

/** True when the browser reached us over HTTPS (directly or via the hosting edge). */
export function isHttpsRequest(headers: Headers, url?: URL): boolean {
  const forwarded = headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === 'https';
  return url?.protocol === 'https:';
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A state-changing request from another site. Next rejects cross-origin Server Actions itself;
 * this also covers route handlers and requests without an `Origin` header (then the browser's
 * `Sec-Fetch-Site` decides). The host comes from the forwarded host like Next's own check.
 */
export function isCrossOriginWrite(method: string, headers: Headers): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const origin = headers.get('origin');
  if (origin === null) {
    return headers.get('sec-fetch-site') === 'cross-site';
  }
  const host = (headers.get('x-forwarded-host')?.split(',')[0] ?? headers.get('host'))?.trim();
  if (!host) return true;
  try {
    // Both sides in the WHATWG URL serialization (lowercase, punycode, IPv6 brackets, default
    // port dropped); the host header is read with the Origin's scheme so `:443`/`:80` compare equal.
    const { protocol, host: originHost } = new URL(origin);
    if (protocol !== 'http:' && protocol !== 'https:') return true;
    const ownHost = new URL(`${protocol}//${host}`).host;
    return originHost !== ownHost;
  } catch {
    return true; // `Origin: null`, other opaque values and malformed host headers
  }
}
