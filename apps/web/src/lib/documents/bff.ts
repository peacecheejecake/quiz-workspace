// Same-origin relay from the browser to FastAPI for DOC-01/DOC-02 (src/app/api/**/route.ts).
//
// Why a relay instead of browser → FastAPI with a Bearer token: the Supabase session cookies are
// HttpOnly (docs/auth.md §5, A3), so browser code has no access token, and handing one to it
// would let any injected script exfiltrate a bearer credential. Each relay request verifies the
// session server-side (`getClaims()`), forwards with `Authorization: Bearer` (job events with
// fetch streaming, implementation-plan §7) and passes FastAPI's answer through unchanged —
// FastAPI stays the authorization boundary. No token ever reaches the browser, a URL or a log.
// Cross-site writes are rejected before they get here (src/proxy.ts).
import { getServerApiBaseUrl } from '@/lib/api/base-url';
import { bearerHeaders, verifiedAccessToken } from '@/lib/api/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Upload-intent and complete-upload bodies are a few hundred bytes. */
const MAX_JSON_BODY_BYTES = 8 * 1024;
/** Idempotency-Key: 1-200 visible ASCII characters (FastAPI checks the same pattern). */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

const NO_STORE = { 'Cache-Control': 'private, no-store, no-transform' } as const;

export function problemResponse(status: number, title: string, detail?: string): Response {
  return Response.json(
    { type: 'about:blank', title, status, ...(detail ? { detail } : {}) },
    { status, headers: { ...NO_STORE, 'Content-Type': 'application/problem+json' } },
  );
}

export const notFound = () => problemResponse(404, 'Not Found');

export interface RelayOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Request whose JSON body is forwarded (POST/PATCH). */
  readonly body?: Request;
  /** Body size limit in bytes (default 8 KiB). */
  readonly maxBodyBytes?: number;
  /** Forward the browser's `Idempotency-Key` header from this request (when well-formed). */
  readonly idempotencyFrom?: Request;
  /** Forward a `text/event-stream` response as a stream. */
  readonly stream?: boolean;
  /** Ends the upstream request when the browser goes away. */
  readonly signal?: AbortSignal;
  /** Pass a successful file response through: its `Content-Disposition` (DOC-03 export). */
  readonly attachment?: boolean;
}

/** `attachment` Content-Disposition values FastAPI sends (no CR/LF, bounded). */
const ATTACHMENT = /^attachment;[\x20-\x7e]{1,2048}$/;

async function readJsonBody(request: Request, maxBytes: number): Promise<string | null> {
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

/** Forwards to `{API}/api/v1{path}` as the current user; `path` must be built from validated ids. */
export async function relayToApi(path: string, options: RelayOptions): Promise<Response> {
  let body: string | undefined;
  if (options.body) {
    const json = await readJsonBody(options.body, options.maxBodyBytes ?? MAX_JSON_BODY_BYTES);
    if (json === null) return problemResponse(400, 'Bad Request', 'Expected a JSON object body.');
    body = json;
  }

  const idempotencyKey = options.idempotencyFrom?.headers.get('idempotency-key') ?? null;
  if (idempotencyKey !== null && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return problemResponse(400, 'Bad Request', 'Malformed Idempotency-Key header.');
  }

  const supabase = await createSupabaseServerClient();
  const token = await verifiedAccessToken(supabase);
  if (!token) return problemResponse(401, 'Unauthorized', 'Sign in again.');

  let upstream: Response;
  try {
    upstream = await fetch(`${getServerApiBaseUrl()}/api/v1${path}`, {
      method: options.method,
      headers: {
        ...bearerHeaders(token),
        accept: options.stream
          ? 'text/event-stream'
          : options.attachment
            ? 'text/markdown, text/plain, application/json'
            : 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(idempotencyKey !== null ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal: options.signal,
    });
  } catch {
    return problemResponse(503, 'Service Unavailable', 'The API is temporarily unavailable.');
  }

  const headers = new Headers(NO_STORE);
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);
  // Rate limits (429) and maintenance (503) tell the browser when to come back.
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter && /^[\w ,:+-]{1,64}$/.test(retryAfter)) headers.set('Retry-After', retryAfter);
  if (options.stream && upstream.ok) {
    // No buffering between here and the browser (reverse proxies, compression).
    headers.set('X-Accel-Buffering', 'no');
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  if (upstream.status === 204) return new Response(null, { status: 204, headers });
  const disposition = upstream.headers.get('content-disposition');
  if (options.attachment && upstream.ok && disposition && ATTACHMENT.test(disposition)) {
    headers.set('Content-Disposition', disposition);
    headers.set('X-Content-Type-Options', 'nosniff');
  }
  return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
}

/** Query string of the allowed, validated parameters of `request` (`?a=1&b=2` or `''`). */
export function forwardQuery(
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

/** `?revision=` values FastAPI accepts: `active`, `latest` or a revision id. */
export const REVISION_SELECTOR =
  /^(active|latest|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Canonical block ids: 1-256 non-space characters (FastAPI path constraint). */
export function isBlockId(value: unknown): value is string {
  return typeof value === 'string' && /^\S{1,256}$/.test(value);
}
