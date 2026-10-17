// Typed fetch client over the generated OpenAPI types. Auth (Bearer injection) is wired by
// the caller via `headers` or middleware (A2.1); this package never reads tokens itself.
import createClient, { type ClientOptions } from 'openapi-fetch';
import type { components, paths } from './generated/schema.ts';

export type { components, operations, paths } from './generated/schema.ts';

export type Schemas = components['schemas'];
/** RFC 9457 problem details returned by every API error (`application/problem+json`). */
export type Problem = Schemas['Problem'];

export type ApiClient = ReturnType<typeof createClient<paths>>;

export function createApiClient(options: ClientOptions & { baseUrl: string }): ApiClient {
  return createClient<paths>(options);
}
