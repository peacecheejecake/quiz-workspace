// QIMPORT-01 first render (Server Component): the workspace's newest import run (or, with
// `?document=`, the newest run of that question paper, QIMPORT-01-AC06) and its drafts, so a
// reload shows the same import with its review and registration state. Unknown/foreign
// workspaces never get here (the workspace layout already answered 404).
//
// The drafts reach the client already in the review shape (`reviewDraftFromImport`, what the
// screen keeps in state anyway), not as the API's `ImportDraft`s: those repeat the validations,
// timestamps, run ids, producer ids and extraction block ids the screen never reads (QIMP-PAYLOAD).
// And only the first page of them carries its content (QIMP-PAGING): every draft travels in the
// initial RSC payload as a summary (selection, counts, registration), the other pages' content is
// read by the screen when it shows them (~1000 drafts of a 316-page paper).
import { notFound, redirect } from 'next/navigation';
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import type { DocumentSummary } from '@/lib/documents/client-api';
import { loginRedirectPath } from '@/lib/auth/routes';
import { DRAFT_PAGE_SIZE, summaryFromImport, summaryOf, withLoaded } from './draft-pages';
import {
  reviewDraftFromImport,
  sortDrafts,
  type BookChapterOption,
  type DraftSummary,
  type ImportRun,
  type ReviewDraft,
} from './drafts';
import { classifyImportFailure, importPath } from './import-client';
import { REVIEW_RUNS } from './review-pdfs';

export interface ImportScreenData {
  readonly run: ImportRun | null;
  /** Every draft of the run without its content, in source order (QIMP-PAGING). */
  readonly summaries: readonly DraftSummary[];
  /** The drafts of the first page in the review shape, in source order. */
  readonly drafts: readonly ReviewDraft[];
  /** The workspace's book chapters: the draft chapter picker (CHAPTER-MAP). */
  readonly chapters: readonly BookChapterOption[];
  /** When the run was read (ISO): a registration that ends later is reported on arrival. */
  readonly loadedAt: string;
  /** The newest run or its drafts could not be loaded (the screen offers a reload). */
  readonly loadFailed: boolean;
}

export async function loadLatestImport(
  workspaceId: string,
  documentId?: string,
): Promise<ImportScreenData> {
  let api;
  try {
    api = await createServerApiClient();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(loginRedirectPath(importPath(workspaceId, documentId)));
    }
    throw error;
  }
  const outcome = (status: number, body: unknown, { workspace = false } = {}) => {
    const kind = classifyImportFailure(status, body);
    if (kind === 'unauthenticated')
      redirect(loginRedirectPath(importPath(workspaceId, documentId)));
    if (kind === 'notFound' && workspace) notFound();
  };

  const loadedAt = new Date().toISOString();
  const runs = await api
    .GET('/api/v1/workspaces/{workspace_id}/question-imports', {
      params: {
        path: { workspace_id: workspaceId },
        query: documentId ? { limit: 1, document_id: documentId } : { limit: 1 },
      },
    })
    .catch(() => null);
  if (!runs)
    return { run: null, summaries: [], drafts: [], chapters: [], loadedAt, loadFailed: true };
  if (!runs.data) {
    outcome(runs.response.status, runs.error, { workspace: true });
    return { run: null, summaries: [], drafts: [], chapters: [], loadedAt, loadFailed: true };
  }
  const run = runs.data.items[0] ?? null;
  if (!run) {
    return { run: null, summaries: [], drafts: [], chapters: [], loadedAt, loadFailed: false };
  }

  const [summaries, page] = await Promise.all([
    api
      .GET('/api/v1/question-imports/{import_id}/draft-summaries', {
        params: { path: { import_id: run.id } },
      })
      .catch(() => null),
    api
      .GET('/api/v1/question-imports/{import_id}/drafts', {
        params: {
          path: { import_id: run.id },
          query: { offset: 0, limit: DRAFT_PAGE_SIZE, include_chapters: false },
        },
      })
      .catch(() => null),
  ]);
  if (!summaries?.data || !page?.data) {
    const failed = summaries?.data ? page : summaries;
    if (failed && !failed.data) outcome(failed.response.status, failed.error);
    return { run, summaries: [], drafts: [], chapters: [], loadedAt, loadFailed: true };
  }
  // The two reads are independent: the first page's summaries are taken from the content shown
  // (a chapter suggestion can change between them without a new draft version).
  const drafts = sortDrafts(page.data.items.map(reviewDraftFromImport));
  return {
    run,
    summaries: withLoaded(
      sortDrafts(summaries.data.items.map(summaryFromImport)),
      new Map(),
      drafts,
    ).summaries.map(summaryOf),
    drafts,
    chapters: summaries.data.chapters ?? [],
    loadedAt,
    loadFailed: false,
  };
}

export interface ReviewListData {
  readonly documents: readonly DocumentSummary[];
  /** The newest runs, newest first (order and counts of the list). */
  readonly runs: readonly ImportRun[];
  /** The documents could not be read: the list is unknown (the screen offers a reload). */
  readonly failed: boolean;
}

/**
 * The documents and newest runs behind `검토할 PDF` (QIMPORT-02): one read of each, summary
 * fields only — no other PDF's drafts.
 */
export async function loadReviewList(workspaceId: string): Promise<ReviewListData> {
  let api;
  try {
    api = await createServerApiClient();
  } catch {
    return { documents: [], runs: [], failed: true };
  }
  const [runs, documents] = await Promise.all([
    api
      .GET('/api/v1/workspaces/{workspace_id}/question-imports', {
        params: { path: { workspace_id: workspaceId }, query: { limit: REVIEW_RUNS } },
      })
      .catch(() => null),
    api
      .GET('/api/v1/workspaces/{workspace_id}/documents', {
        params: { path: { workspace_id: workspaceId } },
      })
      .catch(() => null),
  ]);
  if (!documents?.data) return { documents: [], runs: [], failed: true };
  // The runs only order the list and give its counts; without them every PDF is still listed.
  return { documents: documents.data.items, runs: runs?.data?.items ?? [], failed: false };
}
