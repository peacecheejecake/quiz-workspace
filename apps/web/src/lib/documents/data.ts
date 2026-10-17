// Server-side read of a workspace's documents for the DOC-01 first render (Bearer stays server-side).
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
