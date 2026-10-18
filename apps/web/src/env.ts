// Browser-safe configuration only. Every value here is inlined into client bundles, so only
// `NEXT_PUBLIC_` variables listed in docs/deployment.md §6 belong here. Server-only secrets
// (SUPABASE_SECRET_KEY, DATABASE_URL, ...) must never be read from this module.
//
// Each variable is referenced literally (`process.env.NEXT_PUBLIC_X`) so Next.js can inline it.

export interface PublicEnv {
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
  readonly apiBaseUrl: string;
}

type RawPublicEnv = Readonly<Record<keyof PublicEnv, string | undefined>>;

const VARIABLE_NAMES: Readonly<Record<keyof PublicEnv, string>> = {
  supabaseUrl: 'NEXT_PUBLIC_SUPABASE_URL',
  supabasePublishableKey: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  apiBaseUrl: 'NEXT_PUBLIC_API_BASE_URL',
};

const URL_KEYS = new Set<keyof PublicEnv>(['supabaseUrl', 'apiBaseUrl']);

function readRaw(): RawPublicEnv {
  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
  };
}

/** Validates raw values; throws naming the missing/invalid variables (never their values). */
export function parsePublicEnv(raw: RawPublicEnv): PublicEnv {
  const problems: string[] = [];
  const result: Partial<Record<keyof PublicEnv, string>> = {};
  for (const key of Object.keys(VARIABLE_NAMES) as (keyof PublicEnv)[]) {
    const value = raw[key]?.trim();
    const name = VARIABLE_NAMES[key];
    if (!value) {
      problems.push(`${name} is not set`);
      continue;
    }
    if (URL_KEYS.has(key) && !/^https?:\/\//.test(value)) {
      problems.push(`${name} must be an http(s) URL`);
      continue;
    }
    result[key] = URL_KEYS.has(key) ? value.replace(/\/+$/, '') : value;
  }
  if (problems.length > 0) {
    throw new Error(`Invalid public environment: ${problems.join('; ')}`);
  }
  return result as PublicEnv;
}

/**
 * Cloudflare Turnstile sitekey (docs/auth.md §5.1). Optional: unset or blank = auth CAPTCHA off
 * (no widget, no Turnstile origins in the CSP, no `captchaToken`). Must match Supabase
 * `[auth.captcha]` of the same environment.
 */
export function turnstileSiteKey(): string | undefined {
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || undefined;
}

let cached: PublicEnv | undefined;

/**
 * Lazily validated so stub routes build and render without a configured backend; the first
 * feature that talks to Supabase or the API (A2.1) fails loudly if the values are missing.
 */
export function getPublicEnv(): PublicEnv {
  cached ??= parsePublicEnv(readRaw());
  return cached;
}
