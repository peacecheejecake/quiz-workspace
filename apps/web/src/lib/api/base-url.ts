// Base URL of FastAPI for calls made by the Next.js server (Server Components, Server Actions, Route
// Handlers / BFF relays). `API_INTERNAL_BASE_URL` is server-only (no `NEXT_PUBLIC_` prefix, never
// inlined into a client bundle): a private-network address of the same API (e.g. `http://api:8000`
// on a shared Docker network) so server-side calls skip the public edge. Unset → the public
// `NEXT_PUBLIC_API_BASE_URL`, which stays the browser-facing origin (CSP `connect-src`).
import { getPublicEnv } from '@/env';

const VARIABLE = 'API_INTERNAL_BASE_URL';

/** Validates the override; throws naming the variable (never its value). */
export function parseServerApiBaseUrl(
  env: Readonly<Record<string, string | undefined>>,
  publicBaseUrl: string,
): string {
  const value = env.API_INTERNAL_BASE_URL?.trim();
  if (!value) return publicBaseUrl;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid server environment: ${VARIABLE} must be an http(s) URL`);
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`Invalid server environment: ${VARIABLE} must be an http(s) URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid server environment: ${VARIABLE} must be a plain base URL`);
  }
  return value.replace(/\/+$/, '');
}

let cached: string | undefined;

/** The API base URL for server-side calls (validated once per process). */
export function getServerApiBaseUrl(): string {
  cached ??= parseServerApiBaseUrl(process.env, getPublicEnv().apiBaseUrl);
  return cached;
}
