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

/** Credentials for a user the test signs up itself through the app UI (not created yet). */
export function newCredentials(label = 'user'): Pick<TestUser, 'email' | 'password'> {
  return { email: uniqueEmail(label), password: uniquePassword() };
}

/** Admin lookup of a user id by exact email; undefined when no such user exists. */
export async function findUserIdByEmail(email: string): Promise<string | undefined> {
  const res = await authFetch(`/admin/users?per_page=1000&filter=${encodeURIComponent(email)}`, {
    method: 'GET',
    key: 'secret',
  });
  if (!res.ok) throw await failure('list users', res);
  const body = (await res.json()) as { users?: { id: string; email?: string }[] };
  return body.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id;
}

/** True once the Auth server records the user's email as confirmed. */
export async function isEmailConfirmed(id: string): Promise<boolean> {
  const res = await authFetch(`/admin/users/${encodeURIComponent(id)}`, {
    method: 'GET',
    key: 'secret',
  });
  if (!res.ok) throw await failure('get user', res);
  const body = (await res.json()) as { email_confirmed_at?: string | null };
  return !!body.email_confirmed_at;
}

/** Public password-recovery request (the Auth call behind AUTH-05); sends the recovery mail. */
export async function requestPasswordRecovery(email: string): Promise<void> {
  const res = await authFetch('/recover', { method: 'POST', key: 'publishable', body: { email } });
  if (!res.ok) throw await failure('recover', res);
}

/**
 * Redeems a token hash from an auth mail directly at the Auth server (bypassing the app), e.g.
 * to make a link already used. Returns the HTTP status only.
 */
export async function verifyTokenHashStatus(type: string, tokenHash: string): Promise<number> {
  const res = await authFetch('/verify', {
    method: 'POST',
    key: 'publishable',
    body: { type, token_hash: tokenHash },
  });
  await res.body?.cancel();
  return res.status;
}

/**
 * Redeems a refresh token. Returns the HTTP status only (never the new tokens): 200 means the
 * token was still usable, 4xx that the Auth server rejected it.
 */
export async function refreshStatus(refreshToken: string): Promise<number> {
  const res = await authFetch('/token?grant_type=refresh_token', {
    method: 'POST',
    key: 'publishable',
    body: { refresh_token: refreshToken },
  });
  await res.body?.cancel();
  return res.status;
}

/** True when password sign-in through the Auth API succeeds (no session is returned). */
export async function canSignIn(user: Pick<TestUser, 'email' | 'password'>): Promise<boolean> {
  try {
    await signIn(user);
    return true;
  } catch {
    return false;
  }
}

/** Tracks users created during one test and deletes them all on `cleanup()`. */
export class UserFactory {
  readonly #created: TestUser[] = [];
  readonly #adopted: string[] = [];
  readonly #emails: string[] = [];

  async create(options: CreateUserOptions = {}): Promise<TestUser> {
    const user = await createUser(options);
    this.#created.push(user);
    this.#emails.push(user.email);
    return user;
  }

  /**
   * Public sign-up through the Auth API (`POST /signup`, what a sign-up form does): the user is
   * unconfirmed and the Auth server mails the confirmation link (AUTH-03/04/07 flows).
   */
  async signUp(options: Pick<CreateUserOptions, 'label'> = {}): Promise<TestUser> {
    const { email, password } = newCredentials(options.label);
    this.#emails.push(email);
    const res = await authFetch('/signup', {
      method: 'POST',
      key: 'publishable',
      body: { email, password },
    });
    if (!res.ok) throw await failure('sign up', res);
    const body = (await res.json()) as { id?: string; user?: { id?: string } };
    const id = body.user?.id ?? body.id;
    if (!id) throw new Error('sign up: response has no user id');
    const user = { id, email, password };
    this.#created.push(user);
    return user;
  }

  /**
   * Registers an address the test signs up with through the app UI, so cleanup deletes that user
   * (looked up by email at cleanup time; a user that was never created is fine) and its mail.
   */
  adopt(email: string): void {
    this.#adopted.push(email);
    this.#emails.push(email);
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
    const adopted = this.#adopted.splice(0);
    const results = await Promise.allSettled([
      ...users.map((u) => deleteUser(u.id)),
      ...adopted.map(async (email) => {
        const id = await findUserIdByEmail(email);
        if (id) await deleteUser(id);
      }),
    ]);
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
      const total = users.length + adopted.length;
      throw new Error(`user cleanup failed for ${failed.length}/${total} user(s)`);
    }
  }
}
