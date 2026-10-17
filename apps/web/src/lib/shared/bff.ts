// Same-origin relay for the guest share view (WS-VIEW-01; docs/workspace-sharing.md §2, S1b).
//
// The browser never calls FastAPI directly (implementation-plan §7). The share page sends the
// `#k=` fragment secret ONCE, in a POST body, to `/api/shared/{id}/sessions`; this relay forwards it
// to `POST /api/v1/shared/{id}/sessions` and turns FastAPI's session cookie into this origin's own
// `quiz_share_session` cookie: HttpOnly (no script can read it), SameSite=Lax, Secure over HTTPS,
// scoped to `Path=/api/shared/{id}` so it is sent only to this link's relay routes. Reads forward
// that cookie (and nothing else: no Supabase session, no Authorization) and pass FastAPI's answer
// through; FastAPI re-checks the link on every request and stays the authorization boundary. When
// it says the session is over (401/404 from the share check) the cookie is cleared here too.
//
// The secret and the cookie value never go into a URL, a log line or an error message. Every
// response is `private, no-store`, `no-referrer`, `noindex, nofollow`. Cross-site writes never get
// here (src/proxy.ts); the exchange also forwards the browser's `Origin`, which FastAPI requires to
// be the web origin.

export const SHARE_COOKIE = 'quiz_share_session';
/** The API's session cookie lifetime cap (8 h); a larger Max-Age from upstream is clamped. */
export const MAX_SESSION_SECONDS = 8 * 60 * 60;
/** `{"secret": "<43 chars>"}` plus slack. */
const MAX_EXCHANGE_BODY_BYTES = 1024;
/** Search bodies: query (≤ 4000 chars) and filters. */
export const MAX_SEARCH_BODY_BYTES = 32 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COOKIE_VALUE = /^[A-Za-z0-9._-]{1,512}$/;

export const SHARED_HEADERS = {
  'Cache-Control': 'private, no-store, no-transform',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
} as const;

const SESSION_OVER_TYPES = new Set([
  'urn:quiz-workspace:problem:share-unavailable',
  'urn:quiz-workspace:problem:share-session-required',
]);

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function sharedProblem(status: number, title: string, detail?: string): Response {
  return Response.json(
    { type: 'about:blank', title, status, ...(detail ? { detail } : {}) },
    {
      status,
      headers: { ...SHARED_HEADERS, 'Content-Type': 'application/problem+json' },
    },
  );
}

/** Path the guest's cookie is scoped to: the relay routes of this one link. */
export function cookiePath(shareId: string): string {
  return `/api/shared/${shareId}`;
}

export interface CookieOptions {
  readonly secure: boolean;
}

export function sessionCookie(
  shareId: string,
  value: string,
  maxAge: number,
  { secure }: CookieOptions,
): string {
  const parts = [
    `${SHARE_COOKIE}=${value}`,
    `Path=${cookiePath(shareId)}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie(shareId: string, { secure }: CookieOptions): string {
  return sessionCookie(shareId, '', 0, { secure });
}

/** The value of `name` in a `Cookie` request header (first occurrence), or null. */
export function readCookie(header: string | null, name: string = SHARE_COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return COOKIE_VALUE.test(value) ? value : null;
    }
  }
  return null;
}

/** Value and Max-Age of the upstream share cookie (`Set-Cookie` from FastAPI), or null. */
export function upstreamSession(headers: Headers): { value: string; maxAge: number } | null {
  const lines =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie') ?? ''];
  for (const line of lines) {
    const [pair, ...attributes] = line.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    if (!pair || eq < 0 || pair.slice(0, eq).trim() !== SHARE_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    if (!COOKIE_VALUE.test(value)) return null;
    let maxAge = 0;
    for (const attribute of attributes) {
      const [k, v] = attribute.split('=');
      if (k?.trim().toLowerCase() === 'max-age') maxAge = Number(v?.trim());
    }
    if (!Number.isInteger(maxAge) || maxAge <= 0) return null;
    return { value, maxAge: Math.min(maxAge, MAX_SESSION_SECONDS) };
  }
  return null;
}

async function readJsonObject(request: Request, maxBytes: number): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? JSON.stringify(parsed)
      : null;
  } catch {
    return null;
  }
}

export interface RelayContext {
  /** FastAPI base URL (no trailing slash). */
  readonly apiBaseUrl: string;
  /** The browser reached us over HTTPS (Secure cookie). */
  readonly secure: boolean;
  readonly fetch?: typeof fetch;
  /**
   * Signed statement of which client this relay acts for (`X-Quiz-Relay-Client` +
   * `X-Quiz-Relay-Signature`, see src/lib/shared/context.ts), so FastAPI's per-client rate limits
   * see the visitor instead of this server. Absent: FastAPI keys on the socket peer.
   */
  readonly clientHeaders?: Readonly<Record<string, string>>;
}

function withSharedHeaders(upstream: Response): Headers {
  const headers = new Headers(SHARED_HEADERS);
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);
  return headers;
}

async function isSessionOver(upstream: Response): Promise<boolean> {
  if (upstream.status !== 401 && upstream.status !== 404) return false;
  try {
    const body = (await upstream.clone().json()) as { type?: unknown };
    return typeof body.type === 'string' && SESSION_OVER_TYPES.has(body.type);
  } catch {
    return false;
  }
}

/**
 * `POST /api/shared/{id}/sessions` → FastAPI exchange. 204 + this origin's session cookie, or
 * FastAPI's problem (403 origin, 404 link unavailable, 429 + Retry-After) unchanged.
 */
export async function exchangeSession(
  request: Request,
  shareId: string,
  ctx: RelayContext,
): Promise<Response> {
  if (!isUuid(shareId)) return sharedProblem(404, 'Not Found');
  const body = await readJsonObject(request, MAX_EXCHANGE_BODY_BYTES);
  if (body === null) return sharedProblem(400, 'Bad Request', 'Expected a JSON object body.');
  const origin = request.headers.get('origin');
  let upstream: Response;
  try {
    upstream = await (ctx.fetch ?? fetch)(`${ctx.apiBaseUrl}/api/v1/shared/${shareId}/sessions`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(origin ? { origin } : {}),
        ...ctx.clientHeaders,
      },
      body,
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return sharedProblem(503, 'Service Unavailable', 'The API is temporarily unavailable.');
  }
  const headers = withSharedHeaders(upstream);
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) headers.set('Retry-After', retryAfter);
  if (upstream.status === 204) {
    const session = upstreamSession(upstream.headers);
    if (session === null) {
      return sharedProblem(502, 'Bad Gateway', 'The API did not start a session.');
    }
    headers.append(
      'Set-Cookie',
      sessionCookie(shareId, session.value, session.maxAge, { secure: ctx.secure }),
    );
    return new Response(null, { status: 204, headers });
  }
  return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
}

export interface ReadOptions {
  readonly method?: 'GET' | 'POST';
  /** Request whose JSON body is forwarded (POST). */
  readonly body?: Request;
  readonly maxBodyBytes?: number;
  /** Query string to append (already validated), e.g. `?limit=20` or ''. */
  readonly query?: string;
  /** Stream the upstream body (PDF). */
  readonly stream?: boolean;
  readonly signal?: AbortSignal;
}

/** Forwards a shared read to `{API}/api/v1/shared/{id}{subpath}` with the guest's session only. */
export async function relayShared(
  request: Request,
  shareId: string,
  subpath: string,
  ctx: RelayContext,
  options: ReadOptions = {},
): Promise<Response> {
  if (!isUuid(shareId)) return sharedProblem(404, 'Not Found');
  let body: string | undefined;
  if (options.body) {
    const json = await readJsonObject(options.body, options.maxBodyBytes ?? MAX_SEARCH_BODY_BYTES);
    if (json === null) return sharedProblem(400, 'Bad Request', 'Expected a JSON object body.');
    body = json;
  }
  const session = readCookie(request.headers.get('cookie'));
  let upstream: Response;
  try {
    upstream = await (ctx.fetch ?? fetch)(
      `${ctx.apiBaseUrl}/api/v1/shared/${shareId}${subpath}${options.query ?? ''}`,
      {
        method: options.method ?? 'GET',
        headers: {
          accept: options.stream ? 'application/pdf' : 'application/json',
          ...ctx.clientHeaders,
          ...(session ? { cookie: `${SHARE_COOKIE}=${session}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body,
        cache: 'no-store',
        redirect: 'manual',
        signal: options.signal,
      },
    );
  } catch {
    return sharedProblem(503, 'Service Unavailable', 'The API is temporarily unavailable.');
  }
  const headers = withSharedHeaders(upstream);
  for (const name of ['retry-after', 'content-length', 'content-disposition']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (session !== null && (await isSessionOver(upstream))) {
    headers.append('Set-Cookie', clearedSessionCookie(shareId, { secure: ctx.secure }));
  }
  if (options.stream && upstream.ok) {
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
}

/** `?a=1&b=2` of the allowed, validated parameters of `request`, `''`, or null if one is bad. */
export function sharedQuery(
  request: Request,
  allowed: Readonly<Record<string, RegExp>>,
): string | null {
  const incoming = new URL(request.url).searchParams;
  const out = new URLSearchParams();
  for (const [name, pattern] of Object.entries(allowed)) {
    const value = incoming.get(name);
    if (value === null) continue;
    if (!pattern.test(value)) return null;
    out.set(name, value);
  }
  const text = out.toString();
  return text ? `?${text}` : '';
}

export const UUID_PARAM = UUID;
export const INT_PARAM = /^-?[0-9]{1,9}$/;
export const CURSOR_PARAM = /^[A-Za-z0-9_-]{1,500}$/;
export const QUESTION_TYPE_PARAM = /^[A-Z_]{1,32}$/;
