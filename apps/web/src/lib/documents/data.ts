// Server-side reads for the DOC-01/DOC-02 first render (the Bearer token stays server-side).
import type { Schemas } from '@quiz/api-client';
import { redirect, unstable_rethrow } from 'next/navigation';
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import { loginRedirectPath } from '@/lib/auth/routes';

export type DocumentSummary = Schemas['DocumentSummary'];

export class DocumentsLoadError extends Error {
  constructor(readonly status: number) {
    super(`Documents API request failed (HTTP ${status})`);
    this.name = 'DocumentsLoadError';
  }
}

export async function loadDocuments(workspaceId: string): Promise<DocumentSummary[]> {
  return (await loadDocumentList(workspaceId)).items;
}

async function loadDocumentList(workspaceId: string): Promise<Schemas['DocumentList']> {
  const returnTo = `/workspaces/${workspaceId}`;
  let api;
  try {
    api = await createServerApiClient();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect(loginRedirectPath(returnTo));
    throw error;
  }
  const { data, response } = await api.GET('/api/v1/workspaces/{workspace_id}/documents', {
    params: { path: { workspace_id: workspaceId } },
  });
  if (data) return data;
  if (response.status === 401) redirect(loginRedirectPath(returnTo));
  throw new DocumentsLoadError(response.status);
}

/**
 * `loadDocuments` for a page that still renders without its documents (the home's 문서 n and
 * 문서 관리 dialog): a failure becomes `failed: true`; redirects still apply. After a failure the
 * environment is unknown: `summaryAvailable` stays true so a retried list never loses `요약`.
 */
export async function loadDocumentsOrFailure(workspaceId: string): Promise<{
  readonly documents: DocumentSummary[];
  readonly failed: boolean;
  readonly summaryAvailable: boolean;
}> {
  try {
    const list = await loadDocumentList(workspaceId);
    return { documents: list.items, failed: false, summaryAvailable: list.summary_available };
  } catch (error) {
    unstable_rethrow(error);
    return { documents: [], failed: true, summaryAvailable: true };
  }
}

export type DocumentDetail = Schemas['DocumentDetail'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DOC-02 first render: the document, or null when it does not exist for this user (404). */
export async function loadDocument(
  workspaceId: string,
  documentId: string,
): Promise<DocumentDetail | null> {
  if (!UUID.test(documentId)) return null;
  const returnTo = `/workspaces/${workspaceId}/documents/${documentId}`;
  let api;
  try {
    api = await createServerApiClient();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect(loginRedirectPath(returnTo));
    throw error;
  }
  const { data, response } = await api.GET('/api/v1/documents/{document_id}', {
    params: { path: { document_id: documentId } },
  });
  if (data) return data;
  if (response.status === 401) redirect(loginRedirectPath(returnTo));
  if (response.status === 404 || response.status === 422) return null;
  throw new DocumentsLoadError(response.status);
}
