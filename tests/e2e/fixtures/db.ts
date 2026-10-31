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
//   5. Scaling up state the AC is about beyond what a synthetic fixture yields in E2E time: the
//      hundreds of drafts of a real question PDF (copies of extracted drafts) for QIMPORT-01-AC09,
//      and the hundreds of outline chapters of a real book (QIMP-REVIEW-SCALE).
//   6. Holding a parsed document in `processing` (DOC-03-AC03): with a worker running, no public
//      API keeps a document unprocessed long enough to assert the row and the server's 409.
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

/**
 * Appends `copies` copies of every draft an import run already has (use 5 in the file comment):
 * same type, payload and validations, each with its own id, position and question number, and
 * a stem suffixed with ` #<copy>` so it stays unique. Returns the run's draft count.
 */
export function seedImportDraftCopies(importId: string, copies: number): number {
  if (!Number.isInteger(copies) || copies < 1 || copies > 1000) {
    throw new Error('db fixture: invalid copy count');
  }
  const run = uuidList([importId]);
  psql(
    `with base as (select count(*)::int as n from public.question_drafts where import_run_id = ${run}) ` +
      `insert into public.question_drafts (workspace_id, source_type, import_run_id, position, ` +
      `question_number, question_type, is_multi_answer, rubric, payload, validations) ` +
      `select d.workspace_id, d.source_type, d.import_run_id, d.position + g * base.n, ` +
      `d.position + g * base.n + 1, d.question_type, d.is_multi_answer, d.rubric, ` +
      `jsonb_set(jsonb_set(d.payload, '{id}', to_jsonb((d.payload->>'id') || '-c' || g)), ` +
      `'{stem}', to_jsonb((d.payload->>'stem') || ' #' || g)), d.validations ` +
      `from public.question_drafts d, base, generate_series(1, ${copies}) g ` +
      `where d.import_run_id = ${run}`,
  );
  return Number(
    psql(`select count(*) from public.question_drafts where import_run_id = ${run}`).trim(),
  );
}

/**
 * Appends `count` level-1 chapters (`제N장 합성 단원 N`) to the outline of a processed book's
 * active revision (use 5 in the file comment): a real textbook's outline has hundreds of nodes,
 * the synthetic fixture a handful. Published revisions are immutable for the application (the
 * `chapters_revision_content_guard` trigger), so the insert skips triggers for its own transaction
 * only (one `-c` string = one implicit transaction); the rows reference the book's own workspace, document and revision.
 */
export function seedBookChapters(documentId: string, count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > 2000) {
    throw new Error('db fixture: invalid chapter count');
  }
  const doc = uuidList([documentId]);
  const n = psql(
    `set local session_replication_role = replica; ` +
      `with ins as (insert into public.chapters (workspace_id, document_id, document_revision_id, ` +
      `section_key, level, sort_order, title) ` +
      `select d.workspace_id, d.id, d.active_revision_id, 'e2e-scale-' || g, 1, 100000 + g, ` +
      `'제' || (100 + g) || '장 합성 단원 ' || g ` +
      `from public.documents d, generate_series(1, ${count}) g ` +
      `where d.id = ${doc} and d.active_revision_id is not null returning 1) ` +
      `select count(*) from ins`,
  ).trim();
  if (n !== String(count)) throw new Error('db fixture: book revision not found');
}

/**
 * Puts a document back into `processing` (use 6 in the file comment): the row shows as being
 * processed and has no published revision, like a first upload whose parse has not finished.
 */
export function holdDocumentProcessing(documentId: string): void {
  const n = psql(
    `with u as (update public.documents set status = 'processing', active_revision_id = null ` +
      `where id = ${uuidList([documentId])} returning 1) select count(*) from u`,
  ).trim();
  if (n !== '1') throw new Error('db fixture: document row not found');
}
