// Deployment smoke target (M7.4a, docs/deployment.md §9 DEP-01..07, docs/runbook-deploy.md).
//
// SMOKE_TARGET=local      the local stack (`make smoke-local`): loopback URLs, synthetic users the
//                         global setup creates and deletes with the local Auth admin key.
// SMOKE_TARGET=staging    a deployed environment (`make smoke-staging`): HTTPS URLs and two
//                         pre-created, confirmed smoke accounts (SMOKE_USER_{A,B}_{EMAIL,PASSWORD}).
// SMOKE_TARGET=production read-only checks only (`--grep @readonly`); no account is used.
//
// Values are kept in memory; error messages name variables, never values.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Target = 'local' | 'staging' | 'production';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface Account {
  readonly email: string;
  readonly password: string;
}

export interface SmokeEnv {
  readonly target: Target;
  /** staging/production: served over HTTPS behind real domains. */
  readonly deployed: boolean;
  readonly webUrl: string;
  readonly apiUrl: string;
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  /** Qdrant endpoint for the "no access without the API key" check (deployed only). */
  readonly qdrantUrl: string | undefined;
  readonly stateDir: string;
  readonly jobTimeoutMs: number;
}

function value(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function trim(url: string): string {
  return url.replace(/\/+$/, '');
}

export function smokeTarget(): Target {
  const raw = value('SMOKE_TARGET') ?? 'local';
  if (raw !== 'local' && raw !== 'staging' && raw !== 'production') {
    throw new Error('SMOKE_TARGET must be local, staging or production');
  }
  return raw;
}

let cached: SmokeEnv | undefined;

export function smokeEnv(): SmokeEnv {
  if (cached) return cached;
  const target = smokeTarget();
  const deployed = target !== 'local';
  const pickUrl = (names: readonly string[], fallback: string | undefined): string | undefined => {
    for (const name of names) {
      const v = value(name);
      if (v) return trim(v);
    }
    return fallback;
  };
  // Deployed targets never fall back to the local defaults or the app's own variables.
  const webUrl = pickUrl(['E2E_BASE_URL'], deployed ? undefined : 'http://127.0.0.1:3000');
  const apiUrl = pickUrl(
    deployed ? ['SMOKE_API_URL'] : ['SMOKE_API_URL', 'NEXT_PUBLIC_API_BASE_URL'],
    deployed ? undefined : 'http://127.0.0.1:8000',
  );
  const supabaseUrl = pickUrl(
    deployed ? ['SMOKE_SUPABASE_URL'] : ['SMOKE_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'],
    deployed ? undefined : 'http://127.0.0.1:54321',
  );
  const publishableKey =
    value('SMOKE_SUPABASE_PUBLISHABLE_KEY') ??
    (deployed ? undefined : value('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'));

  const missing = [
    ['E2E_BASE_URL', webUrl],
    ['SMOKE_API_URL', apiUrl],
    ['SMOKE_SUPABASE_URL', supabaseUrl],
    ['SMOKE_SUPABASE_PUBLISHABLE_KEY', publishableKey],
  ]
    .filter(([, v]) => !v)
    .map(([name]) => name);
  // Locally the publishable key may also come from `supabase status` (global setup fills it).
  const keyOnly = missing.length === 1 && missing[0] === 'SMOKE_SUPABASE_PUBLISHABLE_KEY';
  if (!webUrl || !apiUrl || !supabaseUrl || (missing.length && (deployed || !keyOnly))) {
    throw new Error(`smoke (${target}): missing ${missing.join(', ')}`);
  }
  if (deployed) {
    for (const [name, url] of [
      ['E2E_BASE_URL', webUrl],
      ['SMOKE_API_URL', apiUrl],
      ['SMOKE_SUPABASE_URL', supabaseUrl],
    ] as const) {
      if (!url.startsWith('https://')) throw new Error(`smoke (${target}): ${name} must be https`);
    }
  }
  const timeout = Number(value('SMOKE_JOB_TIMEOUT_MS') ?? (deployed ? 20 * 60_000 : 120_000));
  cached = {
    target,
    deployed,
    webUrl,
    apiUrl,
    supabaseUrl,
    publishableKey: publishableKey ?? '',
    qdrantUrl: deployed ? pickUrl(['SMOKE_QDRANT_URL'], undefined) : undefined,
    stateDir: value('SMOKE_STATE_DIR') ?? join(REPO_ROOT, 'test-results-smoke'),
    jobTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000,
  };
  return cached;
}

/** The two smoke accounts (A owns data, B must never see it). */
export function accounts(): { readonly a: Account; readonly b: Account } {
  const read = (who: 'A' | 'B'): Account => {
    const email = value(`SMOKE_USER_${who}_EMAIL`);
    const password = process.env[`SMOKE_USER_${who}_PASSWORD`];
    if (!email || !password) {
      throw new Error(`smoke: SMOKE_USER_${who}_EMAIL / SMOKE_USER_${who}_PASSWORD are required`);
    }
    return { email, password };
  };
  return { a: read('A'), b: read('B') };
}

/** Accounts exist on local (global setup) and staging; production runs read-only checks only. */
export function hasAccounts(): boolean {
  return smokeTarget() !== 'production';
}
