// Workspace history (HISTORY-01) fixtures: read-API helpers for activities / jobs / attempts,
// document-correction helpers that produce history through the public API, and the HISTORY-01 UI
// label contract. M7.0 keeps every assumption about M7.1 in this header (mirrored by
// tests/integration/history/test_history_api_contract.py).
//
// Grounded in the docs and the code: GET /workspaces/{id}/activities (architecture §6, keyset
// index activity_events_workspace_created_idx), GET /jobs/{id}, GET /questions/{id}/attempts (the
// caller's own, M5.2); `activity_events` rows written today: document.uploaded / .deleted /
// .block_corrected {revision_id, block_id} / .publish_requested {revision_id, job_id} /
// .revision_restored, question.created / .updated {version, changed} / .status_changed /
// .deleted, question.study_state_changed {visibility: "actor", ...} (implementation-plan §7:
// personal favorite/retry history is visible to its actor only); a failed reindex is a
// `document.parse` job of the draft revision with error_code `indexing_failed`, retried by
// POST /documents/{id}/publish (DOC-02-AC04, M3.4).
//
// NOT in the docs (M7.0 assumptions; M7.1 implemented them as written, apps/api/src/quiz_api/api/
// history.py: limit 1-100 (default 50); a `user_id` on /attempts is refused with 422; attempts on
// soft-deleted questions are omitted; `retryable` also needs an edit role in an active workspace
// and, for a reindex, that its draft is still the document's current correction draft):
//   H1 GET /workspaces/{id}/activities?limit=&cursor= → 200 {items: Activity[], next_cursor}
//      newest first, any member (viewer included); `question.study_state_changed` only for its
//      actor. Activity = {id, event_type, target_type, target_id, target_label: string|null,
//      actor: {id, display_name: string|null} | null, created_at, revision: {id: string|null,
//      number: number|null} | null}. `revision` = the document revision a correction/publish/
//      restore touched (number = revision_number) or the question revision a change produced
//      (number = version). Never raw block text, question text, answers or secrets: target_label
//      is a document title / "N번 문제"-style label.
//   H2 GET /workspaces/{id}/jobs?limit=&cursor= → 200 {items: WorkspaceJob[], next_cursor}, newest
//      first, any member. WorkspaceJob = the GET /jobs/{id} Job + {target_type: "document" |
//      "question_import" | "question_generation" | null, target_id, target_label, retryable:
//      bool}; `retryable` = the user can start the job again from History (a failed/cancelled
//      document parse/reindex or question import), false for succeeded/running jobs. The UI's
//      retry action calls the existing endpoint for the target (document → POST /documents/{id}/
//      publish for a correction draft, or the upload retry; import → POST /question-imports/{id}/
//      retry), which creates a NEW job (the failed one stays in the list).
//   H3 GET /workspaces/{id}/attempts?limit=&cursor= → 200 {items: WorkspaceAttempt[],
//      next_cursor}, the CALLER's attempts in the workspace only, newest first; any other
//      user's attempts are never returned (a `user_id` query parameter is ignored or refused).
//      WorkspaceAttempt = the M5.2 Attempt + {question_id, question_number, question_type}.
//   H4 Unknown, foreign or soft-deleted workspace → 404 (same body) for all three lists.
//
// UI contract (Korean first, English accepted; AGENTS.md §5):
//   HISTORY-01 route /workspaces/{id}/history; h1 "이력"; three regions (tabs or sections, each a
//              role=region or tabpanel named) "변경 이력", "작업", "풀이 이력". Lists inside them
//              (role=list), one listitem per entry showing: the actor ("나" for the viewer's own
//              entries, else the display name), the time in a <time datetime=ISO> element, the
//              target label, and the revision ("r2" / "v2" / "버전 2" / "revision 2"). A failed
//              job shows its cause as text (indexing → "색인 실패"), "재시도 가능" (or "재시도
//              불가"), and a "다시 시도" button when retryable. A practice attempt shows the
//              question label and its result (정답/오답/채점 대기).
import { expect, type Locator, type Page } from '@playwright/test';
import { JOB_TIMEOUT_MS, type Job } from './documents.ts';
import { main } from './workspace-ui.ts';
import type { Member } from './workspaces.ts';

export interface Activity {
  readonly id: string;
  readonly event_type: string;
  readonly target_type: string;
  readonly target_id: string | null;
  readonly target_label: string | null;
  readonly actor: { readonly id: string; readonly display_name: string | null } | null;
  readonly created_at: string;
  readonly revision: { readonly id: string | null; readonly number: number | null } | null;
}

export interface WorkspaceJob extends Job {
  readonly job_type: string;
  readonly error_code: string | null;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly retryable: boolean;
  readonly created_at: string;
}

export interface WorkspaceAttempt {
  readonly id: string;
  readonly question_id: string;
  readonly result: 'correct' | 'incorrect' | 'pending';
  readonly submitted_at: string;
}

async function list<T>(member: Member, path: string): Promise<T[]> {
  const body = await member.api.ok<{ items: T[] }>('GET', path, undefined, [200]);
  return body.items;
}

export function listActivities(member: Member, workspaceId: string): Promise<Activity[]> {
  return list<Activity>(member, `/workspaces/${workspaceId}/activities?limit=100`);
}

export function listWorkspaceJobs(member: Member, workspaceId: string): Promise<WorkspaceJob[]> {
  return list<WorkspaceJob>(member, `/workspaces/${workspaceId}/jobs?limit=100`);
}

export function listWorkspaceAttempts(
  member: Member,
  workspaceId: string,
): Promise<WorkspaceAttempt[]> {
  return list<WorkspaceAttempt>(member, `/workspaces/${workspaceId}/attempts?limit=100`);
}

// ---------------------------------------------------------------------------------------------
// Producing history through the public API (M3.4 document corrections)
// ---------------------------------------------------------------------------------------------

interface ContentBlock {
  readonly block_id: string;
  readonly text: string;
  readonly page: number;
  readonly version: string;
}

export interface CorrectedBlock {
  readonly blockId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
}

/** Corrects the page-`page` block containing `snippet` to `text` (creates/updates the draft). */
export async function correctBlock(
  owner: Member,
  documentId: string,
  page: number,
  snippet: string,
  text: string,
): Promise<CorrectedBlock> {
  const blocks = await owner.api.ok<{ items: ContentBlock[] }>(
    'GET',
    `/documents/${documentId}/blocks?revision=latest&page=${page}&limit=200`,
    undefined,
    [200],
  );
  const block = blocks.items.find((b) => b.text.includes(snippet));
  if (!block) throw new Error(`no block on page ${page} contains the snippet`);
  const saved = await owner.api.ok<{ revision: { id: string; revision_number: number } }>(
    'PATCH',
    `/documents/${documentId}/blocks/${encodeURIComponent(block.block_id)}`,
    { text, base_version: block.version },
    [200],
  );
  return {
    blockId: block.block_id,
    revisionId: saved.revision.id,
    revisionNumber: saved.revision.revision_number,
  };
}

/** Publishes the correction draft; returns the reindex job id (POST /documents/{id}/publish). */
export async function publishDocument(owner: Member, documentId: string): Promise<string> {
  const accepted = await owner.api.ok<{ job_id: string }>(
    'POST',
    `/documents/${documentId}/publish`,
    {},
    [202],
  );
  return accepted.job_id;
}

/** Polls GET /jobs/{id} (no sleeps) until terminal and asserts the final status. */
export async function waitForJobStatus(
  member: Member,
  jobId: string,
  status: 'succeeded' | 'failed',
): Promise<void> {
  await expect
    .poll(
      async () => (await member.api.ok<Job>('GET', `/jobs/${jobId}`, undefined, [200])).status,
      { message: `job reaches ${status}`, timeout: JOB_TIMEOUT_MS },
    )
    .toBe(status);
}

// ---------------------------------------------------------------------------------------------
// UI (HISTORY-01)
// ---------------------------------------------------------------------------------------------

/** The workspace home with the "이력" dialog open (UX3c; `/history` redirects here). */
export function historyPath(workspaceId: string): string {
  return `/workspaces/${workspaceId}?panel=history`;
}

export const historyUi = {
  /** Header icon button (left of 공유하기) that opens the dialog. */
  button: (page: Page) => main(page).getByRole('button', { name: /^(이력|history)$/i }),
  dialog: (page: Page) => main(page).getByRole('dialog', { name: /^(이력|history)$/i }),
  /** The one chronological list (변경·작업·풀이 merged, newest first). */
  list: (page: Page) => historyUi.dialog(page).getByRole('list', { name: /^(이력|history)$/i }),
  /** Rows of one kind, by their kind badge (변경 / 작업 / 풀이). */
  ofKind: (page: Page, kind: 'activity' | 'job' | 'attempt') =>
    historyUi
      .list(page)
      .getByRole('listitem')
      .filter({
        has: page.getByText(
          { activity: /^(변경|change)$/i, job: /^(작업|job)$/i, attempt: /^(풀이|attempt)$/i }[
            kind
          ],
        ),
      }),
  items: (scope: Locator) => scope.getByRole('listitem'),
  time: (item: Locator) => item.locator('time[datetime]'),
  revision: (n: number) =>
    new RegExp(`(?<![\\p{L}\\d])(r|v|rev\\.?|revision|버전|개정|리비전)\\s*${n}(?!\\d)`, 'iu'),
  me: /(?<!\p{L})(나|본인|me|you)(?!\p{L})/iu,
  indexFailed: /색인.*실패|indexing failed|reindex(ing)? failed/i,
  retryable: /재시도 가능|다시 시도할 수 있|retryable|can be retried/i,
  retry: (item: Locator) => item.getByRole('button', { name: /다시 시도|재시도|retry/i }),
};
