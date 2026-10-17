// Same-origin relay from the browser to FastAPI for DOC-01 (src/app/api/**/route.ts).
//
// Why a relay instead of browser → FastAPI with a Bearer token: the Supabase session cookies are
// HttpOnly (docs/auth.md §5, A3), so browser code has no access token, and handing one to it
// would let any injected script exfiltrate a bearer credential. Each relay request verifies the
// session server-side (`getClaims()`), forwards with `Authorization: Bearer` (job events with
// fetch streaming, implementation-plan §7) and passes FastAPI's answer through unchanged —
// FastAPI stays the authorization boundary. No token ever reaches the browser, a URL or a log.
// Cross-site writes are rejected before they get here (src/proxy.ts).
import { getPublicEnv } from '@/env';
import { bearerHeaders, verifiedAccessToken } from '@/lib/api/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Upload-intent and complete-upload bodies are a few hundred bytes. */
const MAX_JSON_BODY_BYTES = 8 * 1024;

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
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** Request whose JSON body is forwarded (POST). */
  readonly body?: Request;
  /** Forward a `text/event-stream` response as a stream. */
  readonly stream?: boolean;
  /** Ends the upstream request when the browser goes away. */
  readonly signal?: AbortSignal;
}

async function readJsonBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_JSON_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) return null;
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
    const json = await readJsonBody(options.body);
    if (json === null) return problemResponse(400, 'Bad Request', 'Expected a JSON object body.');
    body = json;
  }

  const supabase = await createSupabaseServerClient();
  const token = await verifiedAccessToken(supabase);
  if (!token) return problemResponse(401, 'Unauthorized', 'Sign in again.');

  let upstream: Response;
  try {
    upstream = await fetch(`${getPublicEnv().apiBaseUrl}/api/v1${path}`, {
      method: options.method,
      headers: {
        ...bearerHeaders(token),
        accept: options.stream ? 'text/event-stream' : 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
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
  if (options.stream && upstream.ok) {
    // No buffering between here and the browser (reverse proxies, compression).
    headers.set('X-Accel-Buffering', 'no');
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  if (upstream.status === 204) return new Response(null, { status: 204, headers });
  return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
}
