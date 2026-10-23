// Server-only wiring of the share relay (src/app/api/shared/**/route.ts): API base URL, whether
// the session cookie gets `Secure` (the browser reached us over HTTPS), and the signed client
// identity for FastAPI's per-client rate limits (apps/api/src/quiz_api/relay_client.py).
//
// Client identity: every relay request reaches FastAPI from this server, so FastAPI cannot tell
// visitors apart by socket address. The relay derives an opaque id from the client address the
// hosting edge reports in the header named by `RELAY_CLIENT_IP_HEADER` (e.g. `x-real-ip` behind
// an edge that overwrites it; never a header the browser can set on a direct connection) and
// signs it with `RELAY_CLIENT_SECRET` (server-only, ≥ 32 chars, same value as the API's). Only the
// SHA-256 of the address leaves this server. Without the secret or the header no identity is
// sent and FastAPI keys on the socket peer (local development: one client anyway).
import { createHash, createHmac } from 'node:crypto';
import { getServerApiBaseUrl } from '@/lib/api/base-url';
import { isHttpsRequest } from '@/lib/http/security-headers';
import type { RelayContext } from './bff';

export const RELAY_CLIENT_HEADER = 'x-quiz-relay-client';
export const RELAY_SIGNATURE_HEADER = 'x-quiz-relay-signature';
const MIN_SECRET_CHARS = 32;

/** `{client, signature}` headers for `address` (FastAPI verifies the HMAC). */
export function relayClientHeaders(secret: string, address: string): Record<string, string> {
  const client = createHash('sha256').update(address, 'utf8').digest('base64url');
  const signature = createHmac('sha256', secret)
    .update(`quiz-relay-client/v1|${client}`, 'utf8')
    .digest('hex');
  return { [RELAY_CLIENT_HEADER]: client, [RELAY_SIGNATURE_HEADER]: signature };
}

/** The client address from the configured edge header (first hop), or null. */
export function clientAddress(headers: Headers, headerName: string | undefined): string | null {
  const name = headerName?.trim().toLowerCase();
  if (!name) return null;
  const first = headers.get(name)?.split(',')[0]?.trim();
  return first && first.length <= 256 ? first : null;
}

export function clientHeadersFor(
  headers: Headers,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> | undefined {
  const secret = env.RELAY_CLIENT_SECRET;
  if (!secret || secret.length < MIN_SECRET_CHARS) return undefined;
  const address = clientAddress(headers, env.RELAY_CLIENT_IP_HEADER);
  return address === null ? undefined : relayClientHeaders(secret, address);
}

export function relayContext(request: Request): RelayContext {
  return {
    apiBaseUrl: getServerApiBaseUrl(),
    secure: isHttpsRequest(request.headers, new URL(request.url)),
    clientHeaders: clientHeadersFor(request.headers),
  };
}
