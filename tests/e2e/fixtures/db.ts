// Local Postgres superuser access for E2E fixtures, through `psql` (installed locally and in CI).
//
// Allowed uses only (docs/implementation-plan.md §7: no test-only seed endpoints):
//   1. Cleanup: `workspaces.owner_id` is `on delete restrict`, and the public API only soft-deletes,
//      so a test user's workspaces must be purged before the user can be deleted.
//   2. Seeding state that no public API can create yet and whose *server-side* rejection the AC
//      is about (e.g. a `viewer` membership before membership management exists). Each call site
//      says why.
//   3. Seeding/reading history the AC is about whose public API arrives in a later phase: a
//      graded attempt on a question revision (practice API is M5) for QBANK-01-AC03.
//   4. Recreating legacy state no current code path produces: a processed question PDF without
//      an import run (papers processed before QIMP-AUTO) for QIMPORT-01-AC06.
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

/**
 * Seeds one auto-graded attempt (practice session + attempt) of `userId` on a question revision
 * and returns the attempt id (see use 3 in the file comment).
 */
export function seedGradedAttempt(
  workspaceId: string,
  questionId: string,
  revisionId: string,
  userId: string,
): string {
  const ids = uuidList([workspaceId, questionId, revisionId, userId]);
  return psql(
    `with s as (insert into public.practice_sessions ` +
      `(workspace_id, question_id, question_revision_id, user_id, state, submitted_at, graded_at) ` +
      `values (${ids}, 'graded', now(), now()) ` +
      `returning id, workspace_id, question_id, question_revision_id, user_id) ` +
      `insert into public.question_attempts (workspace_id, question_id, question_revision_id, ` +
      `practice_session_id, user_id, submitted_answer, result, grading_method, graded_at) ` +
      `select workspace_id, question_id, question_revision_id, id, user_id, '{}'::jsonb, ` +
      `'correct', 'auto', now() from s returning id`,
  ).trim();
}

export interface AttemptRevision {
  readonly revisionId: string;
  readonly version: number;
  readonly stem: string;
}

/** The revision an attempt was graded against, read from the immutable history tables. */
export function attemptRevision(attemptId: string): AttemptRevision {
  const out = psql(
    `select json_build_object('revisionId', r.id, 'version', r.version, 'stem', r.stem) ` +
      `from public.question_attempts a join public.question_revisions r ` +
      `on r.id = a.question_revision_id where a.id = ${uuidList([attemptId])}`,
  );
  return JSON.parse(out) as AttemptRevision;
}

/**
 * Removes the import runs (and their drafts) of one question PDF, so it looks like a paper
 * processed before the server started imports itself (use 4 in the file comment). Call it only
 * after the server-started run's job has finished.
 */
export function forgetImportRuns(workspaceId: string, documentId: string): void {
  const [ws, doc] = [uuidList([workspaceId]), uuidList([documentId])];
  psql(
    `delete from public.question_import_runs ` +
      `where workspace_id = ${ws} and source_document_id = ${doc}`,
  );
}
