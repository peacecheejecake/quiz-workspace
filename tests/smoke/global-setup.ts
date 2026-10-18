// Local target only: two confirmed synthetic users through the local Auth admin API (the E2E
// fixtures, which refuse any non-loopback URL), deleted again when the run ends. Staging uses
// pre-created smoke accounts and never sees an admin key; production uses no account at all.
// Teardown hard-deletes the users' workspaces through the local DB (as the E2E fixtures do).
//
// DEP-03 spans two runs around a restart, so locally the seed run keeps its users and records them
// in <SMOKE_STATE_DIR>/dep03-local-users.json (0600; throwaway users of the loopback stack only);
// the verify run reuses and then deletes them.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUser, deleteUser, type TestUser } from '../e2e/fixtures/auth.ts';
import { purgeWorkspacesOwnedBy } from '../e2e/fixtures/db.ts';
import { supabaseKeys } from '../e2e/fixtures/local-env.ts';
import { smokeEnv, smokeTarget } from './env.ts';

export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  if (smokeTarget() !== 'local') return undefined;
  process.env.SMOKE_SUPABASE_PUBLISHABLE_KEY ||= supabaseKeys().publishable;
  const phase = process.env.SMOKE_DEP03_PHASE?.trim();
  const { stateDir } = smokeEnv();
  const saved = join(stateDir, 'dep03-local-users.json');

  const users: TestUser[] =
    phase === 'verify'
      ? (JSON.parse(readFileSync(saved, 'utf8')) as TestUser[])
      : [await createUser({ label: 'smoke-a' }), await createUser({ label: 'smoke-b' })];
  users.forEach((user, i) => {
    const who = i === 0 ? 'A' : 'B';
    process.env[`SMOKE_USER_${who}_EMAIL`] = user.email;
    process.env[`SMOKE_USER_${who}_PASSWORD`] = user.password;
  });
  if (phase === 'seed') {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(saved, JSON.stringify(users), { mode: 0o600 });
    return undefined;
  }
  return async () => {
    // The API only soft-deletes workspaces and `owner_id` restricts user deletion.
    purgeWorkspacesOwnedBy(users.map((u) => u.id));
    for (const user of users) await deleteUser(user.id);
    rmSync(saved, { force: true });
  };
}
