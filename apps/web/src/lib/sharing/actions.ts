'use server';

// WS-SHARE-01 server actions (BFF): validate input, call the owner share-link API with the
// session's Bearer token (never exposed to the client) and answer with the refreshed link list.
// The one-time share URL travels only in the create/rotate result to the owner's browser, which
// keeps it in component state; it is never logged, cached, put in a URL query or stored.
// Authorization (owner only, archived rules) is FastAPI's; these actions only translate answers.
import type { ApiClient } from '@quiz/api-client';
import { redirect } from 'next/navigation';
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import { loginRedirectPath } from '@/lib/auth/routes';
import { isWorkspaceId as isUuid } from '@/lib/workspaces/validation';
import {
  classifyShareFailure,
  isShareUrl,
  SHARE_FAILURE_MESSAGES,
  type ShareFailureKind,
  type ShareLink,
} from './model';

export type ShareActionResult =
  | {
      readonly ok: true;
      readonly links: readonly ShareLink[];
      /** Present right after a create/rotate that returned the secret (shown once). */
      readonly issued?: { readonly linkId: string; readonly shareUrl: string };
      /** An Idempotency-Key replay: the link exists but its secret was already shown. */
      readonly secretAlreadyIssued?: boolean;
    }
  | {
      readonly ok: false;
      readonly failure: ShareFailureKind;
      readonly error: string;
      /** The current list when it could still be read (e.g. after a 409 or an archived 403). */
      readonly links?: readonly ShareLink[];
    };

export interface SharePolicyInput {
  readonly allowFork?: boolean;
  /** ISO instant with offset, or `null` for no expiry. */
  readonly expiresAt?: string | null;
}

type Outcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly failure: ShareFailureKind };

async function callApi<T>(
  workspaceId: string,
  call: (api: ApiClient) => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<Outcome<T>> {
  let outcome: Outcome<T>;
  try {
    const api = await createServerApiClient();
    const { data, error, response } = await call(api);
    outcome = response.ok
      ? { ok: true, data: data as T }
      : { ok: false, failure: classifyShareFailure(response.status, error) };
  } catch (error) {
    outcome = {
      ok: false,
      failure: error instanceof NotAuthenticatedError ? 'unauthenticated' : 'unavailable',
    };
  }
  // redirect() throws, so it stays outside the try block.
  if (!outcome.ok && outcome.failure === 'unauthenticated') {
    redirect(loginRedirectPath(`/workspaces/${workspaceId}/settings/sharing`));
  }
  return outcome;
}

async function listLinks(workspaceId: string): Promise<readonly ShareLink[] | undefined> {
  const result = await callApi(workspaceId, (api) =>
    api.GET('/api/v1/workspaces/{workspace_id}/share-links', {
      params: { path: { workspace_id: workspaceId } },
    }),
  );
  return result.ok ? result.data.items : undefined;
}

function expiryFailure(failure: ShareFailureKind, policy: SharePolicyInput): ShareFailureKind {
  return failure === 'invalid' && typeof policy.expiresAt === 'string' ? 'invalidExpiry' : failure;
}

function failed(failure: ShareFailureKind, links?: readonly ShareLink[]): ShareActionResult {
  return {
    ok: false,
    failure,
    error: SHARE_FAILURE_MESSAGES[failure],
    ...(links ? { links } : {}),
  };
}

async function afterFailure(workspaceId: string, failure: ShareFailureKind) {
  // A gone or foreign workspace has nothing left to list.
  const links = failure === 'notFound' ? undefined : await listLinks(workspaceId);
  return failed(failure, links);
}

async function withList(
  workspaceId: string,
  extra: Partial<Pick<Extract<ShareActionResult, { ok: true }>, 'issued' | 'secretAlreadyIssued'>>,
): Promise<ShareActionResult> {
  const links = await listLinks(workspaceId);
  if (!links) return failed('unavailable');
  return { ok: true, links, ...extra };
}

function validKey(key: unknown): string | undefined {
  return typeof key === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(key) ? key : undefined;
}

function validPolicy(input: unknown): SharePolicyInput | null {
  if (typeof input !== 'object' || input === null) return null;
  const { allowFork, expiresAt } = input as Record<string, unknown>;
  const policy: { allowFork?: boolean; expiresAt?: string | null } = {};
  if (allowFork !== undefined) {
    if (typeof allowFork !== 'boolean') return null;
    policy.allowFork = allowFork;
  }
  if (expiresAt !== undefined) {
    if (
      expiresAt !== null &&
      (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))
    )
      return null;
    policy.expiresAt = expiresAt;
  }
  return policy;
}

interface Issued {
  readonly id: string;
  readonly secret: string | null;
  readonly share_url: string | null;
  readonly secret_already_issued: boolean;
}

async function issuedResult(workspaceId: string, link: Issued): Promise<ShareActionResult> {
  if (link.secret_already_issued || !link.secret) {
    return withList(workspaceId, { secretAlreadyIssued: true });
  }
  if (!isShareUrl(link.share_url, link.id)) return failed('unavailable');
  return withList(workspaceId, { issued: { linkId: link.id, shareUrl: link.share_url } });
}

/** Issues a view-only link (owner, not while archived); the URL is in the result only. */
export async function createShareLinkAction(
  workspaceId: string,
  policy: SharePolicyInput,
  idempotencyKey?: string,
): Promise<ShareActionResult> {
  const body = validPolicy(policy);
  if (!isUuid(workspaceId)) return failed('notFound');
  if (!body) return failed('invalid');
  const key = validKey(idempotencyKey);
  const result = await callApi(workspaceId, (api) =>
    api.POST('/api/v1/workspaces/{workspace_id}/share-links', {
      params: {
        path: { workspace_id: workspaceId },
        ...(key ? { header: { 'Idempotency-Key': key } } : {}),
      },
      body: {
        allow_fork: body.allowFork ?? false,
        ...(body.expiresAt !== undefined ? { expires_at: body.expiresAt } : {}),
      },
    }),
  );
  if (!result.ok) return afterFailure(workspaceId, expiryFailure(result.failure, body));
  return issuedResult(workspaceId, result.data);
}

/** Changes Fork permission and/or expiry of one link (owner; also while archived). */
export async function updateShareLinkAction(
  workspaceId: string,
  linkId: string,
  policy: SharePolicyInput,
): Promise<ShareActionResult> {
  const body = validPolicy(policy);
  if (!isUuid(workspaceId) || !isUuid(linkId)) return failed('notFound');
  if (!body || (body.allowFork === undefined && body.expiresAt === undefined)) {
    return failed('invalid');
  }
  const result = await callApi(workspaceId, (api) =>
    api.PATCH('/api/v1/workspaces/{workspace_id}/share-links/{link_id}', {
      params: { path: { workspace_id: workspaceId, link_id: linkId } },
      body: {
        ...(body.allowFork !== undefined ? { allow_fork: body.allowFork } : {}),
        ...(body.expiresAt !== undefined ? { expires_at: body.expiresAt } : {}),
      },
    }),
  );
  if (!result.ok) return afterFailure(workspaceId, expiryFailure(result.failure, body));
  return withList(workspaceId, {});
}

/**
 * Revokes every given link (owner; also while archived). Repeating it is a no-op. No count limit:
 * the owner may hold any number of links, and "링크 철회" must turn all of them off. Each id is
 * still authorized by the API, exactly as if the owner revoked it directly.
 */
export async function revokeShareLinksAction(
  workspaceId: string,
  linkIds: readonly string[],
): Promise<ShareActionResult> {
  if (!isUuid(workspaceId)) return failed('notFound');
  if (!Array.isArray(linkIds) || linkIds.length === 0) return failed('invalid');
  if (!linkIds.every(isUuid)) return failed('notFound');
  for (const linkId of new Set(linkIds)) {
    const result = await callApi(workspaceId, (api) =>
      api.POST('/api/v1/workspaces/{workspace_id}/share-links/{link_id}/revoke', {
        params: { path: { workspace_id: workspaceId, link_id: linkId } },
      }),
    );
    if (!result.ok) return afterFailure(workspaceId, result.failure);
  }
  return withList(workspaceId, {});
}

/** Revokes a link and issues its replacement (owner, not while archived). */
export async function rotateShareLinkAction(
  workspaceId: string,
  linkId: string,
  idempotencyKey?: string,
): Promise<ShareActionResult> {
  if (!isUuid(workspaceId) || !isUuid(linkId)) return failed('notFound');
  const key = validKey(idempotencyKey);
  const result = await callApi(workspaceId, (api) =>
    api.POST('/api/v1/workspaces/{workspace_id}/share-links/{link_id}/rotate', {
      params: {
        path: { workspace_id: workspaceId, link_id: linkId },
        ...(key ? { header: { 'Idempotency-Key': key } } : {}),
      },
    }),
  );
  if (!result.ok) return afterFailure(workspaceId, result.failure);
  return issuedResult(workspaceId, result.data);
}
