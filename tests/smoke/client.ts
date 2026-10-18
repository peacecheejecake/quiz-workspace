// HTTP helpers for the deployment smoke. Node `fetch` only (never Playwright `request`, which
// lands in traces): JWTs, passwords and signed URLs stay in memory. Errors carry statuses, never
// bodies that could echo credentials.
import { accounts, smokeEnv, type Account } from './env.ts';

export const API_PREFIX = '/api/v1';
/** The only token Cloudflare's Turnstile test secret keys accept. */
export const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

export interface Reply<T = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T | undefined;
  readonly text: string;
}

async function read<T>(res: Response): Promise<Reply<T>> {
  const text = await res.text();
  let body: T | undefined;
  try {
    body = text ? (JSON.parse(text) as T) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, headers: res.headers, body, text };
}

export async function raw<T = unknown>(url: string, init: RequestInit = {}): Promise<Reply<T>> {
  return read<T>(await fetch(url, { redirect: 'manual', ...init }));
}

/** Supabase REST/Storage/Auth call with the publishable key (+ optional user JWT). */
export async function supabase<T = unknown>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Reply<T>> {
  const env = smokeEnv();
  const { token, headers, ...rest } = init;
  const key = env.publishableKey;
  return raw<T>(`${env.supabaseUrl}${path}`, {
    ...rest,
    headers: {
      apikey: key,
      // Legacy JWT anon keys also need the Bearer header; `sb_*` keys do not.
      ...(token
        ? { authorization: `Bearer ${token}` }
        : key.startsWith('sb_')
          ? {}
          : { authorization: `Bearer ${key}` }),
      ...headers,
    },
  });
}

const sessions = new Map<string, Promise<string>>();

/** Password grant against Supabase Auth; one session per account and worker. */
export function accessToken(account: Account): Promise<string> {
  let token = sessions.get(account.email);
  if (!token) {
    token = (async () => {
      const res = await supabase<{ access_token?: string }>('/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: account.email,
          password: account.password,
          // Turnstile test token (docs/auth.md §5.1): staging pairs the always-passes test keys,
          // so Auth accepts it; with CAPTCHA off (local) Auth ignores it.
          gotrue_meta_security: { captcha_token: TURNSTILE_TEST_TOKEN },
        }),
      });
      if (res.status !== 200 || !res.body?.access_token) {
        const hint =
          res.status === 400
            ? ' (CAPTCHA? staging must use the Turnstile test key pair, docs/runbook-deploy.md §2)'
            : '';
        throw new Error(`smoke sign-in failed: HTTP ${res.status}${hint}`);
      }
      return res.body.access_token;
    })();
    sessions.set(account.email, token);
  }
  return token;
}

export class Api {
  readonly #token: string | undefined;

  constructor(token?: string) {
    this.#token = token;
  }

  static async as(who: 'a' | 'b'): Promise<Api> {
    return new Api(await accessToken(accounts()[who]));
  }

  request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply<T>> {
    return raw<T>(`${smokeEnv().apiUrl}${API_PREFIX}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Must answer one of `expected`; otherwise a short error with method, route and status. */
  async ok<T>(
    method: string,
    path: string,
    body?: unknown,
    expected: readonly number[] = [200, 201, 202],
  ): Promise<T> {
    const res = await this.request<T>(method, path, body);
    if (!expected.includes(res.status)) {
      const route = path.replace(/[0-9a-f-]{36}/gi, '{id}');
      throw new Error(`${method} ${API_PREFIX}${route}: HTTP ${res.status}`);
    }
    return res.body as T;
  }
}

export interface Workspace {
  readonly id: string;
}

/** A workspace owned by account A, named so leftovers are recognisable. */
export async function createWorkspace(owner: Api, label: string): Promise<Workspace> {
  const name = `smoke-${label}-${new Date().toISOString().replace(/[:.]/g, '')}`;
  return owner.ok<Workspace>('POST', '/workspaces', { name }, [201]);
}

export async function deleteWorkspace(owner: Api, id: string): Promise<void> {
  await owner.ok('DELETE', `/workspaces/${id}`, undefined, [200, 202, 204, 404]);
}

export interface Question {
  readonly id: string;
  readonly revision: { readonly id: string };
}

export function createMcq(owner: Api, workspaceId: string): Promise<Question> {
  const options = ['하나', '둘', '셋', '넷'].map((text, i) => ({ id: `opt-${i + 1}`, text }));
  return owner.ok<Question>(
    'POST',
    `/workspaces/${workspaceId}/questions`,
    {
      question_type: 'MCQ',
      stem: 'Smoke 문제: 첫 번째 보기를 고르시오.',
      options,
      correct_option_ids: ['opt-1'],
      is_multi_answer: false,
    },
    [201],
  );
}
