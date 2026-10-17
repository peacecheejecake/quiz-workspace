// Local-only endpoints and keys for E2E fixtures.
//
// Every fixture that talks to Supabase Auth or Mailpit goes through this module, which refuses
// any non-loopback URL: fixture code creates and deletes users with the Auth admin key and must
// never be pointed at a shared or production project. Keys are read at runtime (env or
// `supabase status`), kept in memory only and never logged; error messages name variables, not
// values.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Throws unless `raw` is an http(s) URL on a loopback host. Returns it without a trailing slash. */
export function assertLocalUrl(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `${name} must point at the local stack (127.0.0.1/localhost); refusing to run E2E fixtures ` +
        `against ${url.protocol}//${url.host}`,
    );
  }
  return raw.replace(/\/+$/, '');
}

function envUrl(name: string, fallback: string): string {
  return assertLocalUrl(process.env[name]?.trim() || fallback, name);
}

export interface LocalEndpoints {
  readonly baseUrl: string;
  readonly supabaseUrl: string;
  readonly mailpitUrl: string;
  /** FastAPI (`NEXT_PUBLIC_API_BASE_URL`); data fixtures create workspaces/documents through it. */
  readonly apiUrl: string;
}

export function localEndpoints(): LocalEndpoints {
  return {
    baseUrl: envUrl('E2E_BASE_URL', 'http://127.0.0.1:3000'),
    supabaseUrl: envUrl('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321'),
    mailpitUrl: envUrl('E2E_MAILPIT_URL', 'http://127.0.0.1:54324'),
    apiUrl: envUrl('NEXT_PUBLIC_API_BASE_URL', 'http://127.0.0.1:8000'),
  };
}

/**
 * Local Postgres superuser URL (`E2E_DB_ADMIN_URL`, default: the Supabase CLI local database).
 * Only fixture cleanup and the few documented seeds that no public API can create use it.
 */
export function localDbAdminUrl(): string {
  const name = 'E2E_DB_ADMIN_URL';
  const raw =
    process.env[name]?.trim() || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${name} must point at the local database (127.0.0.1/localhost)`);
  }
  return raw;
}

export interface SupabaseKeys {
  /** Browser-safe key (`apikey` for public Auth endpoints). */
  readonly publishable: string;
  /** Server-only admin key. Never send it through `page`/`request` (they are traced). */
  readonly secret: string;
}

let cachedKeys: SupabaseKeys | undefined;

function statusKeys(): Record<string, unknown> {
  let out: string;
  try {
    out = execFileSync('pnpm', ['exec', 'supabase', 'status', '-o', 'json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000,
    });
  } catch {
    throw new Error(
      'Supabase local stack is not running (`supabase status` failed); start it with `make infra-up`',
    );
  }
  const start = out.indexOf('{');
  if (start < 0) throw new Error('`supabase status -o json` printed no JSON');
  return JSON.parse(out.slice(start)) as Record<string, unknown>;
}

function pick(status: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = status[name];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/**
 * Supabase keys from SUPABASE_SECRET_KEY / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, falling back to
 * `supabase status -o json` of the local stack (CI and fresh checkouts have no .env).
 */
export function supabaseKeys(): SupabaseKeys {
  if (cachedKeys) return cachedKeys;
  let publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  let secret = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!publishable || !secret) {
    const status = statusKeys();
    publishable ||= pick(status, ['PUBLISHABLE_KEY', 'ANON_KEY']);
    secret ||= pick(status, ['SECRET_KEY', 'SERVICE_ROLE_KEY']);
  }
  if (!publishable || !secret) {
    throw new Error(
      'Supabase keys unavailable: set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and ' +
        'SUPABASE_SECRET_KEY or run the local stack (`make infra-up`)',
    );
  }
  cachedKeys = { publishable, secret };
  return cachedKeys;
}
