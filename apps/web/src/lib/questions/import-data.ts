// QIMPORT-01 first render (Server Component): the workspace's newest import run (or, with
// `?document=`, the newest run of that question paper, QIMPORT-01-AC06) and its drafts, so a
// reload shows the same import with its review and registration state. Unknown/foreign
// workspaces never get here (the workspace layout already answered 404).
import { notFound, redirect } from 'next/navigation';
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import { loginRedirectPath } from '@/lib/auth/routes';
import type { BookChapterOption, ImportDraft, ImportRun } from './drafts';
import { classifyImportFailure, importPath } from './import-client';
import { reviewPdfs, type ReviewPdf } from './review-pdfs';

export interface ImportScreenData {
  readonly run: ImportRun | null;
  readonly drafts: readonly ImportDraft[];
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
  if (!runs) return { run: null, drafts: [], chapters: [], loadedAt, loadFailed: true };
  if (!runs.data) {
    outcome(runs.response.status, runs.error, { workspace: true });
    return { run: null, drafts: [], chapters: [], loadedAt, loadFailed: true };
  }
  const run = runs.data.items[0] ?? null;
  if (!run) return { run: null, drafts: [], chapters: [], loadedAt, loadFailed: false };

  const drafts = await api
    .GET('/api/v1/question-imports/{import_id}/drafts', {
      params: { path: { import_id: run.id } },
    })
    .catch(() => null);
  if (!drafts?.data) {
    if (drafts) outcome(drafts.response.status, drafts.error);
    return { run, drafts: [], chapters: [], loadedAt, loadFailed: true };
  }
  return {
    run,
    drafts: drafts.data.items,
    chapters: drafts.data.chapters ?? [],
    loadedAt,
    loadFailed: false,
  };
}

/** How many runs order `검토할 PDF` (the API's maximum page; older PDFs follow, UX6-UPLOAD). */
const REVIEW_RUNS = 200;

/**
 * The PDFs with an extraction for `검토할 PDF` (UX6-UPLOAD), newest extraction first. Best
 * effort: the switcher is left out (empty list) when the documents cannot be read.
 */
export async function loadReviewPdfs(workspaceId: string): Promise<readonly ReviewPdf[]> {
  let api;
  try {
    api = await createServerApiClient();
  } catch {
    return [];
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
  if (!documents?.data) return [];
  // The runs only order the list; without them every extracted PDF is still offered.
  return reviewPdfs(runs?.data?.items ?? [], documents.data.items);
}
