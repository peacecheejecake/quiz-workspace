'use server';

// WS-01 server actions. Each one re-validates its input, calls FastAPI with the session's Bearer
// token (never exposed to the client) and refreshes /workspaces on success. Authorization is the
// API's: these actions only translate its answers (implementation-plan §7) into screen state.
import type { ApiClient } from '@quiz/api-client';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import { loginRedirectPath } from '@/lib/auth/routes';
import {
  classifyWorkspaceFailure,
  WORKSPACE_FAILURE_MESSAGES,
  type WorkspaceFailureKind,
} from './problems';
import { isWorkspaceId, validateWorkspaceName } from './validation';

const HOME = '/workspaces';

export interface WorkspaceFormState {
  readonly status: 'idle' | 'error' | 'done';
  /** Form-level message (role="alert"). */
  readonly error?: string;
  readonly fieldErrors?: { readonly name?: string };
  readonly failure?: WorkspaceFailureKind;
  /** Bumped on every result so the client can react to repeated identical outcomes. */
  readonly attempt?: number;
  readonly workspace?: { readonly id: string; readonly name: string };
}

export type WorkspaceActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: WorkspaceFailureKind; readonly error: string };

type ApiOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly failure: WorkspaceFailureKind };

/** Runs one API call; signed-out sessions and 401s send the browser to /login. */
async function callApi<T>(
  call: (api: ApiClient) => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<ApiOutcome<T>> {
  let outcome: ApiOutcome<T>;
  try {
    const api = await createServerApiClient();
    const { data, error, response } = await call(api);
    outcome = response.ok
      ? { ok: true, data: data as T }
      : { ok: false, failure: classifyWorkspaceFailure(response.status, error) };
  } catch (error) {
    outcome = {
      ok: false,
      failure: error instanceof NotAuthenticatedError ? 'unauthenticated' : 'unavailable',
    };
  }
  // redirect() throws, so it stays outside the try block.
  if (!outcome.ok && outcome.failure === 'unauthenticated') redirect(loginRedirectPath(HOME));
  return outcome;
}

function formFailure(failure: WorkspaceFailureKind, attempt: number): WorkspaceFormState {
  if (failure === 'invalid') {
    return {
      status: 'error',
      failure,
      attempt,
      fieldErrors: { name: WORKSPACE_FAILURE_MESSAGES.invalid },
    };
  }
  return { status: 'error', failure, attempt, error: WORKSPACE_FAILURE_MESSAGES[failure] };
}

function validKey(key: unknown): string | undefined {
  // The API accepts any opaque key; keep it to a sane token so it is safe in a header.
  return typeof key === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(key) ? key : undefined;
}

function readKey(formData: FormData): string | undefined {
  return validKey(formData.get('idempotencyKey'));
}

/**
 * Creates a workspace (the caller becomes its owner). `idempotencyKey` comes from the form: the
 * client keeps it for retries of the same name, so a double submit or a retry after a lost
 * response creates one workspace.
 */
export async function createWorkspaceAction(
  prev: WorkspaceFormState,
  formData: FormData,
): Promise<WorkspaceFormState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const name = validateWorkspaceName(formData.get('name'));
  if (!name.ok) return { status: 'error', attempt, fieldErrors: { name: name.error } };
  const key = readKey(formData);

  const result = await callApi((api) =>
    api.POST('/api/v1/workspaces', {
      body: { name: name.name },
      ...(key ? { params: { header: { 'Idempotency-Key': key } } } : {}),
    }),
  );
  if (!result.ok) return formFailure(result.failure, attempt);
  revalidatePath(HOME);
  return {
    status: 'done',
    attempt,
    workspace: { id: result.data.id, name: result.data.name },
  };
}

/** Renames a workspace (owner, not while archived). */
export async function renameWorkspaceAction(
  prev: WorkspaceFormState,
  formData: FormData,
): Promise<WorkspaceFormState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const id = formData.get('workspaceId');
  if (!isWorkspaceId(id)) return formFailure('notFound', attempt);
  const name = validateWorkspaceName(formData.get('name'));
  if (!name.ok) return { status: 'error', attempt, fieldErrors: { name: name.error } };

  const result = await callApi((api) =>
    api.PATCH('/api/v1/workspaces/{workspace_id}', {
      params: { path: { workspace_id: id } },
      body: { name: name.name },
    }),
  );
  if (!result.ok) return formFailure(result.failure, attempt);
  revalidatePath(HOME);
  revalidatePath(`/workspaces/${id}`, 'layout');
  return { status: 'done', attempt, workspace: { id: result.data.id, name: result.data.name } };
}

type Lifecycle = 'archive' | 'restore' | 'delete';

async function lifecycle(
  action: Lifecycle,
  workspaceId: unknown,
  idempotencyKey?: unknown,
): Promise<WorkspaceActionResult> {
  if (!isWorkspaceId(workspaceId)) {
    return { ok: false, failure: 'notFound', error: WORKSPACE_FAILURE_MESSAGES.notFound };
  }
  const key = validKey(idempotencyKey);
  const params = {
    params: {
      path: { workspace_id: workspaceId },
      ...(key ? { header: { 'Idempotency-Key': key } } : {}),
    },
  };
  const result = await callApi<unknown>((api) => {
    switch (action) {
      case 'archive':
        return api.POST('/api/v1/workspaces/{workspace_id}/archive', params);
      case 'restore':
        return api.POST('/api/v1/workspaces/{workspace_id}/restore', params);
      case 'delete':
        // Soft delete takes no Idempotency-Key: repeating it is a 404 and changes nothing.
        return api.DELETE('/api/v1/workspaces/{workspace_id}', {
          params: { path: { workspace_id: workspaceId } },
        });
    }
  });
  if (!result.ok) {
    // A workspace that vanished meanwhile is gone from the list after the refresh, too.
    if (result.failure === 'notFound') revalidatePath(HOME);
    return {
      ok: false,
      failure: result.failure,
      error: WORKSPACE_FAILURE_MESSAGES[result.failure],
    };
  }
  revalidatePath(HOME);
  revalidatePath(`/workspaces/${workspaceId}`, 'layout');
  return { ok: true };
}

/** Makes a workspace read-only (owner). Repeating it is a no-op on the API. */
export async function archiveWorkspaceAction(
  workspaceId: string,
  idempotencyKey?: string,
): Promise<WorkspaceActionResult> {
  return lifecycle('archive', workspaceId, idempotencyKey);
}

/** Makes an archived workspace writable again (owner). */
export async function restoreWorkspaceAction(
  workspaceId: string,
  idempotencyKey?: string,
): Promise<WorkspaceActionResult> {
  return lifecycle('restore', workspaceId, idempotencyKey);
}

/** Soft-deletes a workspace (owner); afterwards every route answers 404 for it. */
export async function deleteWorkspaceAction(workspaceId: string): Promise<WorkspaceActionResult> {
  return lifecycle('delete', workspaceId);
}
