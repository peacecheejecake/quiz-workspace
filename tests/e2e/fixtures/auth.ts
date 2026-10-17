// Synthetic per-test users against the local Supabase Auth (GoTrue) API.
//
// Calls use Node's `fetch`, not Playwright's `request`/`page`: those are recorded in traces and
// HTML reports, and the admin key, passwords and session tokens must never end up in artifacts
// (docs/e2e-strategy.md §7).
import { randomUUID } from 'node:crypto';
import { localEndpoints, supabaseKeys } from './local-env.ts';

export interface TestUser {
  readonly id: string;
  readonly email: string;
  /** Random per user; only ever typed into the local app or sent to the local Auth API. */
  readonly password: string;
}

export interface AuthSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Unix seconds. */
  readonly expiresAt: number;
  readonly userId: string;
}

export interface CreateUserOptions {
  /** Short label for the email local part, e.g. the AC ID (`auth01-ac02`). */
  readonly label?: string;
  /** Default true. `false` creates an unconfirmed user (signup-verify flows). */
  readonly confirmed?: boolean;
}

/** Unique synthetic address; `example.test` is reserved and never routable. */
export function uniqueEmail(label = 'user'): string {
  const safe =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'user';
  return `e2e-${safe}-${randomUUID()}@example.test`;
}

function uniquePassword(): string {
  return `E2e-${randomUUID()}`;
}

async function authFetch(
  path: string,
  init: { method: string; key: 'publishable' | 'secret'; body?: unknown },
): Promise<Response> {
  const { supabaseUrl } = localEndpoints();
  const keys = supabaseKeys();
  const key = keys[init.key];
  const headers: Record<string, string> = { apikey: key, 'content-type': 'application/json' };
  // Legacy JWT keys also need the Bearer header; `sb_*` keys are mapped by the local gateway.
  if (!key.startsWith('sb_')) headers.authorization = `Bearer ${key}`;
  return fetch(`${supabaseUrl}/auth/v1${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Error text with status only: GoTrue bodies may echo the email but never keys; keep it short. */
async function failure(what: string, res: Response): Promise<Error> {
  let code = '';
  try {
    const body = (await res.json()) as { error_code?: string; code?: string | number };
    code = String(body.error_code ?? body.code ?? '');
  } catch {
    // Non-JSON body: status is enough.
  }
  return new Error(`${what} failed: HTTP ${res.status}${code ? ` (${code})` : ''}`);
}

/** Creates a user through the Auth admin API (confirmed unless `confirmed: false`). */
export async function createUser(options: CreateUserOptions = {}): Promise<TestUser> {
  const email = uniqueEmail(options.label);
  const password = uniquePassword();
  const res = await authFetch('/admin/users', {
    method: 'POST',
    key: 'secret',
    body: { email, password, email_confirm: options.confirmed ?? true },
  });
  if (!res.ok) throw await failure('create user', res);
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error('create user: response has no id');
  return { id: body.id, email, password };
}

/** Deletes a user; a user that is already gone counts as deleted. */
export async function deleteUser(id: string): Promise<void> {
  const res = await authFetch(`/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    key: 'secret',
  });
  if (!res.ok && res.status !== 404) throw await failure('delete user', res);
}

/** True when the Auth admin API still knows the user (harness self-checks cleanup with it). */
export async function userExists(id: string): Promise<boolean> {
  const res = await authFetch(`/admin/users/${encodeURIComponent(id)}`, {
    method: 'GET',
    key: 'secret',
  });
  if (res.status === 404) return false;
  if (!res.ok) throw await failure('get user', res);
  return true;
}

/** Password sign-in through the Auth API (what `/login` will do once A2 lands). */
export async function signIn(user: Pick<TestUser, 'email' | 'password'>): Promise<AuthSession> {
  const res = await authFetch('/token?grant_type=password', {
    method: 'POST',
    key: 'publishable',
    body: { email: user.email, password: user.password },
  });
  if (!res.ok) throw await failure('sign in', res);
  const body = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    user: { id: string };
  };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_at,
    userId: body.user.id,
  };
}

/** Tracks users created during one test and deletes them all on `cleanup()`. */
export class UserFactory {
  readonly #created: TestUser[] = [];
  readonly #emails: string[] = [];

  async create(options: CreateUserOptions = {}): Promise<TestUser> {
    const user = await createUser(options);
    this.#created.push(user);
    this.#emails.push(user.email);
    return user;
  }

  /** Every address this factory ever created (for mailbox cleanup after `cleanup()`). */
  get emails(): readonly string[] {
    return [...this.#emails];
  }

  /** Users this factory created and has not cleaned up yet. */
  get created(): readonly TestUser[] {
    return [...this.#created];
  }

  async cleanup(): Promise<void> {
    const users = this.#created.splice(0);
    const results = await Promise.allSettled(users.map((u) => deleteUser(u.id)));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
      throw new Error(`user cleanup failed for ${failed.length}/${users.length} user(s)`);
    }
  }
}
