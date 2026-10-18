// HISTORY-01 server reads: the first page of each history list through the Bearer helper (the
// access token stays server-side). FastAPI decides what the caller sees: the workspace layout has
// already turned unknown/foreign workspaces into a 404; attempts are always the caller's own.
import { redirect } from 'next/navigation';
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import { loginRedirectPath } from '@/lib/auth/routes';
import {
  HISTORY_PAGE_SIZE,
  type Activity,
  type HistoryLoad,
  type WorkspaceAttempt,
  type WorkspaceJob,
} from './model';

export interface HistoryLoads {
  readonly activities: HistoryLoad<Activity>;
  readonly jobs: HistoryLoad<WorkspaceJob>;
  readonly attempts: HistoryLoad<WorkspaceAttempt>;
}

interface Outcome<T> {
  readonly data?: { items: T[]; next_cursor: string | null };
  readonly response: Response;
}

function settle<T>(result: PromiseSettledResult<Outcome<T>>, returnTo: string): HistoryLoad<T> {
  if (result.status === 'rejected') return { status: 'unavailable' };
  const { data, response } = result.value;
  if (data) return { status: 'ok', page: { items: data.items, nextCursor: data.next_cursor } };
  if (response.status === 401) redirect(loginRedirectPath(returnTo));
  return { status: 'unavailable' };
}

export async function loadHistory(workspaceId: string): Promise<HistoryLoads> {
  const returnTo = `/workspaces/${workspaceId}/history`;
  let api;
  try {
    api = await createServerApiClient();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect(loginRedirectPath(returnTo));
    throw error;
  }
  const params = {
    path: { workspace_id: workspaceId },
    query: { limit: HISTORY_PAGE_SIZE },
  };
  const [activities, jobs, attempts] = await Promise.allSettled([
    api.GET('/api/v1/workspaces/{workspace_id}/activities', { params }),
    api.GET('/api/v1/workspaces/{workspace_id}/jobs', { params }),
    api.GET('/api/v1/workspaces/{workspace_id}/attempts', { params }),
  ]);
  return {
    activities: settle(activities, returnTo),
    jobs: settle(jobs, returnTo),
    attempts: settle(attempts, returnTo),
  };
}
