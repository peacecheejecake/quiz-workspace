// Server-side Workspace reads for Server Components. Calls go through the Bearer helper, so the
// access token never reaches the browser; FastAPI decides what the caller may see.
import type { Schemas } from '@quiz/api-client';
import { notFound, redirect } from 'next/navigation';
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import { loginRedirectPath } from '@/lib/auth/routes';
import { classifyWorkspaceFailure } from './problems';
import { isWorkspaceId } from './validation';

export type Workspace = Schemas['Workspace'];
export type WorkspaceStatus = Workspace['status'];

export interface WorkspaceLists {
  readonly active: readonly Workspace[];
  readonly archived: readonly Workspace[];
}

export class WorkspaceApiError extends Error {
  constructor(readonly status: number) {
    super(`Workspace API request failed (HTTP ${status})`);
    this.name = 'WorkspaceApiError';
  }
}

async function apiClientOrLogin(returnTo: string) {
  try {
    return await createServerApiClient();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect(loginRedirectPath(returnTo));
    throw error;
  }
}

/** Both WS-01 tabs. Signed-out → /login; other failures throw `WorkspaceApiError`. */
export async function loadWorkspaceLists(): Promise<WorkspaceLists> {
  const api = await apiClientOrLogin('/workspaces');
  const [active, archived] = await Promise.all(
    (['active', 'archived'] as const).map(async (status) => {
      const { data, error, response } = await api.GET('/api/v1/workspaces', {
        params: { query: { status } },
      });
      if (data) return data.items;
      if (classifyWorkspaceFailure(response.status, error) === 'unauthenticated') {
        redirect(loginRedirectPath('/workspaces'));
      }
      throw new WorkspaceApiError(response.status);
    }),
  );
  return { active: active ?? [], archived: archived ?? [] };
}

/**
 * The workspace behind a `/workspaces/[workspaceId]/**` route. Unknown, foreign and soft-deleted
 * ids all render the not-found page (HTTP 404) — the API answers them with the same 404.
 */
export async function requireWorkspace(workspaceId: string): Promise<Workspace> {
  if (!isWorkspaceId(workspaceId)) notFound();
  const returnTo = `/workspaces/${workspaceId}/documents`;
  const api = await apiClientOrLogin(returnTo);
  const { data, error, response } = await api.GET('/api/v1/workspaces/{workspace_id}', {
    params: { path: { workspace_id: workspaceId } },
  });
  if (data) return data;
  const failure = classifyWorkspaceFailure(response.status, error);
  if (failure === 'notFound' || failure === 'invalid') notFound();
  if (failure === 'unauthenticated') redirect(loginRedirectPath(returnTo));
  throw new WorkspaceApiError(response.status);
}

/** Active workspaces for the switcher; an empty list on failure (the page itself still loads). */
export async function loadSwitcherWorkspaces(): Promise<readonly Workspace[]> {
  try {
    const api = await createServerApiClient();
    const { data } = await api.GET('/api/v1/workspaces', {
      params: { query: { status: 'active' } },
    });
    return data?.items ?? [];
  } catch {
    return [];
  }
}
