// Local Postgres superuser access for E2E fixtures, through `psql` (installed locally and in CI).
//
// Allowed uses only (docs/implementation-plan.md §7: no test-only seed endpoints):
//   1. Cleanup: `workspaces.owner_id` is `on delete restrict`, and the public API only soft-deletes,
//      so a test user's workspaces must be purged before the user can be deleted.
//   2. Seeding state that no public API can create yet and whose *server-side* rejection the AC
//      is about (e.g. a `viewer` membership before membership management exists). Each call site
//      says why.
// The URL is loopback-checked; ids are validated before they are inlined into SQL.
import { execFileSync } from 'node:child_process';
import { localDbAdminUrl } from './local-env.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Set(['owner', 'editor', 'viewer']);

function uuidList(ids: readonly string[]): string {
  for (const id of ids) if (!UUID.test(id)) throw new Error('db fixture: invalid uuid');
  return ids.map((id) => `'${id}'`).join(',');
}

function psql(sql: string): string {
  try {
    return execFileSync('psql', [localDbAdminUrl(), '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (error) {
    // stderr may echo SQL but never credentials (the URL is an argument, not printed by psql).
    const stderr = (error as { stderr?: string }).stderr?.trim().split('\n')[0] ?? '';
    throw new Error(`db fixture: psql failed${stderr ? `: ${stderr}` : ''}`, { cause: error });
  }
}

/** Hard-deletes every workspace owned by these users (memberships, jobs, documents cascade). */
export function purgeWorkspacesOwnedBy(userIds: readonly string[]): void {
  if (!userIds.length) return;
  psql(`delete from public.workspaces where owner_id in (${uuidList(userIds)})`);
}

/** Seeds a membership row directly (see the file comment for when this is allowed). */
export function seedMembership(workspaceId: string, userId: string, role: string): void {
  if (!ROLES.has(role)) throw new Error('db fixture: invalid role');
  psql(
    `insert into public.workspace_memberships (workspace_id, user_id, role) ` +
      `values (${uuidList([workspaceId])}, ${uuidList([userId])}, '${role}')`,
  );
}
