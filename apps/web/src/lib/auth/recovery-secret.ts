// Server-only secret that signs the `/reset-password` recovery marker (lib/auth/recovery.ts).
// `AUTH_RECOVERY_MARKER_SECRET` must be set (≥ 32 bytes, e.g. `openssl rand -base64 32`) whenever
// `APP_ENV` is not `local`/`test`. Locally an unset value falls back to a random per-process secret:
// markers then simply stop verifying after a server restart (they live 15 minutes anyway).
// Never NEXT_PUBLIC_, never logged.
import { randomBytes } from 'node:crypto';

export const RECOVERY_SECRET_ENV = 'AUTH_RECOVERY_MARKER_SECRET';
const MIN_SECRET_LENGTH = 32;
const LOCAL_ENVS = new Set(['local', 'test']);

// Next bundles route handlers and pages separately, so a module-level variable would give
// `/auth/callback` and `/reset-password` different keys; keep the local key process-wide.
const EPHEMERAL_KEY = Symbol.for('quiz.web.recoveryMarkerSecret');
const processGlobal = globalThis as typeof globalThis & { [EPHEMERAL_KEY]?: string };

/** Resolves the secret from `env`; throws (naming the variable, never a value) when unusable. */
export function resolveRecoveryMarkerSecret(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = env[RECOVERY_SECRET_ENV]?.trim();
  if (value) {
    if (value.length < MIN_SECRET_LENGTH) {
      throw new Error(`${RECOVERY_SECRET_ENV} must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    return value;
  }
  const appEnv = env.APP_ENV?.trim() || 'local';
  if (!LOCAL_ENVS.has(appEnv)) {
    throw new Error(`${RECOVERY_SECRET_ENV} is required when APP_ENV=${appEnv}`);
  }
  processGlobal[EPHEMERAL_KEY] ??= randomBytes(32).toString('base64url');
  return processGlobal[EPHEMERAL_KEY];
}
