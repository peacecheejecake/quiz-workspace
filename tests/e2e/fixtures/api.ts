// Minimal FastAPI client for E2E data fixtures (workspaces, documents, search).
//
// Fixtures create test data through the *public* API as the test's own user (Bearer access token
// from the local Auth API), never through test-only endpoints (AGENTS.md §5). Calls use Node's
// `fetch`, not Playwright's `request`: tokens and signed Storage URLs must not end up in traces.
//
// Until an endpoint exists, FastAPI answers 404 without a `detail` (unknown route) or 405; that
// is reported as "<METHOD> <path> not implemented (<status>)" so RED failures name the missing
// endpoint. A 404 *with* a detail ("Workspace not found.") is a real authorization outcome.
import type { AuthSession } from './auth.ts';
import { localEndpoints } from './local-env.ts';

export const API_PREFIX = '/api/v1';
export const PROBLEM_TYPES = {
  workspaceArchived: 'urn:quiz-workspace:problem:workspace-archived',
  insufficientRole: 'urn:quiz-workspace:problem:insufficient-role',
} as const;

export interface Problem {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
}

export interface ApiResponse<T = unknown> {
  readonly status: number;
  readonly contentType: string;
  /** Parsed JSON body (undefined for empty or non-JSON bodies). */
  readonly body: T | undefined;
  /** Raw body text, for leak checks (never logged). */
  readonly text: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Path with ids replaced by `{id}` so failure messages are stable and leak nothing. */
export function routeOf(path: string): string {
  return path.split('?')[0]?.replace(UUID, '{id}') ?? path;
}

/** True when the response looks like FastAPI's "no such route" (not an authorization 404). */
export function isMissingRoute(res: ApiResponse): boolean {
  if (res.status === 405) return true;
  if (res.status !== 404) return false;
  const problem = res.body as Problem | undefined;
  return !problem?.detail;
}

export class ApiClient {
  readonly #token: string;

  constructor(session: Pick<AuthSession, 'accessToken'>) {
    this.#token = session.accessToken;
  }

  /** Raw call: returns any status (authorization tests assert 403/404 themselves). */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    const url = `${localEndpoints().apiUrl}${API_PREFIX}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(
        `${method} ${API_PREFIX}${routeOf(path)}: API unreachable at NEXT_PUBLIC_API_BASE_URL ` +
          '(Playwright starts it via playwright.config.ts webServer)',
      );
    }
    const text = await res.text();
    let parsed: T | undefined;
    try {
      parsed = text ? (JSON.parse(text) as T) : undefined;
    } catch {
      parsed = undefined;
    }
    return {
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      body: parsed,
      text,
    };
  }

  /** Call that must succeed with one of `expected`; otherwise throws a short, secret-free error. */
  async ok<T>(
    method: string,
    path: string,
    body?: unknown,
    expected: readonly number[] = [200, 201, 202],
    headers: Record<string, string> = {},
  ): Promise<T> {
    const res = await this.request<T>(method, path, body, headers);
    if (expected.includes(res.status)) return res.body as T;
    throw apiError(method, path, res);
  }
}

export function apiError(method: string, path: string, res: ApiResponse): Error {
  const route = `${method} ${API_PREFIX}${routeOf(path)}`;
  if (isMissingRoute(res)) return new Error(`${route} not implemented (${res.status})`);
  const problem = res.body as Problem | undefined;
  const type = problem?.type && problem.type !== 'about:blank' ? ` ${problem.type}` : '';
  return new Error(`${route} failed: HTTP ${res.status}${type}`);
}
