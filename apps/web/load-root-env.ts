// Fallback loader for the monorepo's root `.env*` files (AGENTS.md §7 keeps one git-ignored
// `.env` at the repo root). Next.js has already loaded process env + apps/web/.env* before it
// evaluates next.config, and `@next/env` caches that result, so calling its `loadEnvConfig` again
// for another directory is a no-op. This loader parses the root files itself and only fills keys
// that are still unset: the process environment and app-local files always win.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

type Mode = 'development' | 'production' | 'test';

function currentMode(nodeEnv: string | undefined): Mode {
  if (nodeEnv === 'production' || nodeEnv === 'test') return nodeEnv;
  return 'development';
}

/** Same precedence as Next.js, highest first; `.env.local` is skipped in test mode. */
export function envFilesFor(mode: Mode): string[] {
  return [`.env.${mode}.local`, ...(mode === 'test' ? [] : ['.env.local']), `.env.${mode}`, '.env'];
}

/**
 * Assigns root `.env*` values to `env` for keys that are not already defined.
 * Returns the names (never the values) of the keys it filled.
 */
export function loadRootEnvFallback(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
  mode: Mode = currentMode(process.env.NODE_ENV),
): string[] {
  const filled: string[] = [];
  for (const file of envFilesFor(mode)) {
    const path = join(rootDir, file);
    if (!existsSync(path)) continue;
    const parsed = parseEnv(readFileSync(path, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] !== undefined || value === undefined) continue;
      env[key] = value;
      filled.push(key);
    }
  }
  return filled;
}
