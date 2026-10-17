// Per-request security headers set by `src/proxy.ts` (docs/auth.md §5): a nonce-based CSP that
// Next.js applies to its own scripts, HSTS over HTTPS, and the cross-origin write guard that backs
// up Next's Server Action origin check for any non-GET request (route handlers included).
//
// style-src keeps 'unsafe-inline' on purpose: React and Radix server-render `style="…"`
// attributes (Popper positioning, CSS custom properties such as sizes), and a nonce cannot cover
// attributes. Style injection cannot run script, and script-src stays strict (nonce +
// 'strict-dynamic', no 'unsafe-inline').

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
}: CspOptions): string {
  const connect = [...new Set(connectOrigins.map(originOf).filter((o): o is string => o !== null))];
  const directives: [string, ...string[]][] = [
    ['default-src', "'self'"],
    [
      'script-src',
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(dev ? ["'unsafe-eval'"] : []),
    ],
    ['style-src', "'self'", "'unsafe-inline'"],
    ['img-src', "'self'", 'data:', 'blob:'],
    ['font-src', "'self'", 'data:'],
    ['connect-src', "'self'", ...connect],
    ['frame-src', "'none'"],
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
  const host = (headers.get('x-forwarded-host')?.split(',')[0] ?? headers.get('host'))
    ?.trim()
    .toLowerCase();
  if (!host) return true;
  try {
    return new URL(origin).host.toLowerCase() !== host;
  } catch {
    return true; // `Origin: null` and other opaque values
  }
}
