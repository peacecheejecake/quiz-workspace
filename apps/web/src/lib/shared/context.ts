// Server-only wiring of the share relay (src/app/api/shared/**/route.ts): API base URL and
// whether the session cookie gets `Secure` (the browser reached us over HTTPS).
import { getPublicEnv } from '@/env';
import { isHttpsRequest } from '@/lib/http/security-headers';
import type { RelayContext } from './bff';

export function relayContext(request: Request): RelayContext {
  return {
    apiBaseUrl: getPublicEnv().apiBaseUrl,
    secure: isHttpsRequest(request.headers, new URL(request.url)),
  };
}
