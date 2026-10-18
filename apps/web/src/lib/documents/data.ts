// Server-side reads for the DOC-01/DOC-02 first render (the Bearer token stays server-side).
import type { Schemas } from '@quiz/api-client';
import { redirect } from 'next/navigation';
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
  const returnTo = `/workspaces/${workspaceId}/documents`;
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
  if (data) return data.items;
  if (response.status === 401) redirect(loginRedirectPath(returnTo));
  throw new DocumentsLoadError(response.status);
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
