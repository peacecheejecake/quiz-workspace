// QIMPORT-01 first render (Server Component): the workspace's newest import run (or, with
// `?document=`, the newest run of that question paper, QIMPORT-01-AC06) and its drafts, so a
// reload shows the same import with its review and registration state. Unknown/foreign
// workspaces never get here (the workspace layout already answered 404).
import { notFound, redirect } from 'next/navigation';
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import { loginRedirectPath } from '@/lib/auth/routes';
import type { ImportDraft, ImportRun } from './drafts';
import { classifyImportFailure, importPath } from './import-client';

export interface ImportScreenData {
  readonly run: ImportRun | null;
  readonly drafts: readonly ImportDraft[];
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

  const runs = await api
    .GET('/api/v1/workspaces/{workspace_id}/question-imports', {
      params: {
        path: { workspace_id: workspaceId },
        query: documentId ? { limit: 1, document_id: documentId } : { limit: 1 },
      },
    })
    .catch(() => null);
  if (!runs) return { run: null, drafts: [], loadFailed: true };
  if (!runs.data) {
    outcome(runs.response.status, runs.error, { workspace: true });
    return { run: null, drafts: [], loadFailed: true };
  }
  const run = runs.data.items[0] ?? null;
  if (!run) return { run: null, drafts: [], loadFailed: false };

  const drafts = await api
    .GET('/api/v1/question-imports/{import_id}/drafts', {
      params: { path: { import_id: run.id } },
    })
    .catch(() => null);
  if (!drafts?.data) {
    if (drafts) outcome(drafts.response.status, drafts.error);
    return { run, drafts: [], loadFailed: true };
  }
  return { run, drafts: drafts.data.items, loadFailed: false };
}
