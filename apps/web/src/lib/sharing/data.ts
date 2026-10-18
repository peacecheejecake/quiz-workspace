// WS-SHARE-01 server read: the workspace's share links (metadata only — the API never returns a
// secret or digest here). FastAPI decides access: non-members and deleted workspaces 404, members
// without the owner role 403.
import { notFound, redirect } from 'next/navigation';
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import { loginRedirectPath } from '@/lib/auth/routes';
import { classifyShareFailure, type ShareLink } from './model';

export type ShareLinksLoad =
  | { readonly status: 'ok'; readonly links: readonly ShareLink[] }
  | { readonly status: 'forbidden' }
  | { readonly status: 'unavailable' };

export async function loadShareLinks(workspaceId: string): Promise<ShareLinksLoad> {
  const returnTo = `/workspaces/${workspaceId}/settings/sharing`;
  let api;
  try {
    api = await createServerApiClient();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect(loginRedirectPath(returnTo));
    return { status: 'unavailable' };
  }
  let result;
  try {
    result = await api.GET('/api/v1/workspaces/{workspace_id}/share-links', {
      params: { path: { workspace_id: workspaceId } },
    });
  } catch {
    return { status: 'unavailable' };
  }
  const { data, error, response } = result;
  if (data) return { status: 'ok', links: data.items };
  const failure = classifyShareFailure(response.status, error);
  if (failure === 'unauthenticated') redirect(loginRedirectPath(returnTo));
  if (failure === 'notFound' || failure === 'invalid') notFound();
  return failure === 'forbidden' ? { status: 'forbidden' } : { status: 'unavailable' };
}
