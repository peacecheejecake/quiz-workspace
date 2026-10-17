// WS-01 (M3.1b): name validation mirroring the API, problem → screen mapping, Idempotency-Key
// reuse, and the server actions against a mocked API client (Bearer helper) and Next runtime.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keyForAttempt, newIdempotencyKey } from '../src/lib/workspaces/idempotency';
import {
  classifyWorkspaceFailure,
  PROBLEM_TYPES,
  WORKSPACE_FAILURE_MESSAGES,
} from '../src/lib/workspaces/problems';
import {
  isWorkspaceId,
  validateWorkspaceName,
  WORKSPACE_NAME_MESSAGES,
} from '../src/lib/workspaces/validation';

const api = { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() };
const revalidated: unknown[][] = [];
let signedIn = true;

vi.mock('../src/lib/api/server', () => {
  class NotAuthenticatedError extends Error {}
  return {
    NotAuthenticatedError,
    createServerApiClient: async () => {
      if (!signedIn) throw new NotAuthenticatedError();
      return api;
    },
  };
});
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => {
    revalidated.push(args);
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));

const {
  archiveWorkspaceAction,
  createWorkspaceAction,
  deleteWorkspaceAction,
  renameWorkspaceAction,
  restoreWorkspaceAction,
} = await import('../src/lib/workspaces/actions');
const { requireWorkspace } = await import('../src/lib/workspaces/data');

const WS_ID = '3f2b6f0e-8a4c-4d7e-9a51-1c2d3e4f5a6b';
const KEY = '0b9a7c4e-2d1f-4e3a-8b6c-5d4e3f2a1b0c';
const LOGIN_REDIRECT = 'REDIRECT /login?next=%2Fworkspaces';
const idle = { status: 'idle' } as const;
const workspace = {
  id: WS_ID,
  name: '운영체제',
  role: 'owner',
  status: 'active',
  archived_at: null,
  created_at: '2026-10-17T00:00:00Z',
  updated_at: '2026-10-17T00:00:00Z',
};

function ok<T>(data: T, status = 200) {
  return { data, error: undefined, response: new Response(null, { status }) };
}

function problem(status: number, type = 'about:blank') {
  return {
    data: undefined,
    error: { type, title: 'x', status },
    response: new Response(null, { status }),
  };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  revalidated.length = 0;
  signedIn = true;
});

describe('validateWorkspaceName', () => {
  it('trims and accepts 1–200 characters', () => {
    expect(validateWorkspaceName('  운영체제  ')).toEqual({ ok: true, name: '운영체제' });
    expect(validateWorkspaceName('가'.repeat(200))).toEqual({ ok: true, name: '가'.repeat(200) });
  });

  it('counts code points like the API, not UTF-16 units', () => {
    expect(validateWorkspaceName('😀'.repeat(200)).ok).toBe(true);
    expect(validateWorkspaceName('😀'.repeat(201))).toEqual({
      ok: false,
      error: WORKSPACE_NAME_MESSAGES.tooLong,
    });
  });

  it('rejects blank, missing and control characters', () => {
    for (const raw of ['', '   ', null, undefined, 42]) {
      expect(validateWorkspaceName(raw)).toEqual({
        ok: false,
        error: WORKSPACE_NAME_MESSAGES.required,
      });
    }
    for (const raw of ['a\nb', 'a\tb', 'a\u0000b', 'a\u007fb']) {
      expect(validateWorkspaceName(raw)).toEqual({
        ok: false,
        error: WORKSPACE_NAME_MESSAGES.controlChars,
      });
    }
  });

  it('accepts only UUID workspace ids', () => {
    expect(isWorkspaceId(WS_ID)).toBe(true);
    for (const raw of ['e2e-ws', '', `${WS_ID}/x`, '../etc', null]) {
      expect(isWorkspaceId(raw)).toBe(false);
    }
  });
});

describe('classifyWorkspaceFailure', () => {
  it('maps statuses and problem types to screen outcomes', () => {
    expect(classifyWorkspaceFailure(401, {})).toBe('unauthenticated');
    expect(classifyWorkspaceFailure(403, { type: PROBLEM_TYPES.workspaceArchived })).toBe(
      'archived',
    );
    expect(classifyWorkspaceFailure(403, { type: PROBLEM_TYPES.insufficientRole })).toBe(
      'forbidden',
    );
    expect(classifyWorkspaceFailure(403, undefined)).toBe('forbidden');
    expect(classifyWorkspaceFailure(404, { type: 'about:blank' })).toBe('notFound');
    expect(classifyWorkspaceFailure(409, { type: PROBLEM_TYPES.idempotencyKeyReused })).toBe(
      'idempotencyKeyReused',
    );
    expect(classifyWorkspaceFailure(409, {})).toBe('unavailable');
    expect(classifyWorkspaceFailure(422, {})).toBe('invalid');
    expect(classifyWorkspaceFailure(503, 'not json')).toBe('unavailable');
  });
});

describe('Idempotency-Key per create attempt', () => {
  it('reuses the key for the same name and mints one for a new name', () => {
    let n = 0;
    const mint = () => `key-${++n}`;
    const first = keyForAttempt(null, '운영체제', mint);
    expect(keyForAttempt(first, '운영체제', mint)).toBe(first);
    expect(keyForAttempt(first, '네트워크', mint)).toEqual({ key: 'key-2', name: '네트워크' });
  });

  it('mints v4 UUIDs', () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newIdempotencyKey()).not.toBe(a);
  });
});

describe('createWorkspaceAction', () => {
  it('validates before calling the API', async () => {
    const state = await createWorkspaceAction(idle, form({ name: ' \n ' }));
    expect(state).toMatchObject({
      status: 'error',
      fieldErrors: { name: WORKSPACE_NAME_MESSAGES.required },
    });
    expect(api.POST).not.toHaveBeenCalled();
  });

  it('sends the trimmed name with the Idempotency-Key and refreshes the list', async () => {
    api.POST.mockResolvedValue(ok(workspace, 201));
    const state = await createWorkspaceAction(
      idle,
      form({ name: '  운영체제 ', idempotencyKey: KEY }),
    );
    expect(api.POST).toHaveBeenCalledWith('/api/v1/workspaces', {
      body: { name: '운영체제' },
      params: { header: { 'Idempotency-Key': KEY } },
    });
    expect(state).toMatchObject({ status: 'done', workspace: { id: WS_ID, name: '운영체제' } });
    expect(revalidated).toContainEqual(['/workspaces']);
  });

  it('drops a malformed key instead of forwarding it as a header', async () => {
    api.POST.mockResolvedValue(ok(workspace, 201));
    await createWorkspaceAction(idle, form({ name: 'a', idempotencyKey: 'bad key\r\nX: y' }));
    expect(api.POST).toHaveBeenCalledWith('/api/v1/workspaces', { body: { name: 'a' } });
  });

  it('maps a reused key, API validation and outages to form messages', async () => {
    api.POST.mockResolvedValueOnce(problem(409, PROBLEM_TYPES.idempotencyKeyReused));
    expect(
      await createWorkspaceAction(idle, form({ name: 'a', idempotencyKey: KEY })),
    ).toMatchObject({
      status: 'error',
      failure: 'idempotencyKeyReused',
      error: WORKSPACE_FAILURE_MESSAGES.idempotencyKeyReused,
    });
    api.POST.mockResolvedValueOnce(problem(422));
    expect(await createWorkspaceAction(idle, form({ name: 'a' }))).toMatchObject({
      fieldErrors: { name: WORKSPACE_FAILURE_MESSAGES.invalid },
    });
    api.POST.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await createWorkspaceAction(idle, form({ name: 'a' }))).toMatchObject({
      failure: 'unavailable',
      error: WORKSPACE_FAILURE_MESSAGES.unavailable,
    });
    expect(revalidated).toEqual([]);
  });

  it('sends signed-out users and 401s to /login', async () => {
    signedIn = false;
    await expect(createWorkspaceAction(idle, form({ name: 'a' }))).rejects.toThrow(LOGIN_REDIRECT);
    signedIn = true;
    api.POST.mockResolvedValue(problem(401));
    await expect(createWorkspaceAction(idle, form({ name: 'a' }))).rejects.toThrow(LOGIN_REDIRECT);
  });

  it('bumps the attempt counter on every result', async () => {
    const first = await createWorkspaceAction(idle, form({ name: '' }));
    const second = await createWorkspaceAction(first, form({ name: '' }));
    expect([first.attempt, second.attempt]).toEqual([1, 2]);
  });
});

describe('renameWorkspaceAction', () => {
  it('renames through PATCH and refreshes the home and the workspace layout', async () => {
    api.PATCH.mockResolvedValue(ok({ ...workspace, name: '새 이름' }));
    const state = await renameWorkspaceAction(idle, form({ workspaceId: WS_ID, name: '새 이름' }));
    expect(api.PATCH).toHaveBeenCalledWith('/api/v1/workspaces/{workspace_id}', {
      params: { path: { workspace_id: WS_ID } },
      body: { name: '새 이름' },
    });
    expect(state).toMatchObject({ status: 'done', workspace: { name: '새 이름' } });
    expect(revalidated).toEqual([['/workspaces'], [`/workspaces/${WS_ID}`, 'layout']]);
  });

  it('shows the archived problem instead of renaming', async () => {
    api.PATCH.mockResolvedValue(problem(403, PROBLEM_TYPES.workspaceArchived));
    expect(
      await renameWorkspaceAction(idle, form({ workspaceId: WS_ID, name: 'x' })),
    ).toMatchObject({ failure: 'archived', error: WORKSPACE_FAILURE_MESSAGES.archived });
  });

  it('never calls the API for a non-UUID id', async () => {
    expect(
      await renameWorkspaceAction(idle, form({ workspaceId: '../me', name: 'x' })),
    ).toMatchObject({ failure: 'notFound' });
    expect(api.PATCH).not.toHaveBeenCalled();
  });
});

describe('lifecycle actions', () => {
  it.each([
    ['archive', archiveWorkspaceAction, 'POST', '/api/v1/workspaces/{workspace_id}/archive'],
    ['restore', restoreWorkspaceAction, 'POST', '/api/v1/workspaces/{workspace_id}/restore'],
    ['delete', deleteWorkspaceAction, 'DELETE', '/api/v1/workspaces/{workspace_id}'],
  ] as const)('%s calls the API and refreshes', async (_name, action, method, path) => {
    api[method].mockResolvedValue(ok(method === 'DELETE' ? undefined : workspace, 200));
    expect(await action(WS_ID)).toEqual({ ok: true });
    expect(api[method]).toHaveBeenCalledWith(path, { params: { path: { workspace_id: WS_ID } } });
    expect(revalidated).toContainEqual(['/workspaces']);
  });

  it('treats a 204 delete as success', async () => {
    api.DELETE.mockResolvedValue({
      data: undefined,
      error: undefined,
      response: new Response(null, { status: 204 }),
    });
    expect(await deleteWorkspaceAction(WS_ID)).toEqual({ ok: true });
  });

  it('reports role and visibility failures without refreshing a stale success', async () => {
    api.POST.mockResolvedValueOnce(problem(403, PROBLEM_TYPES.insufficientRole));
    expect(await archiveWorkspaceAction(WS_ID)).toEqual({
      ok: false,
      failure: 'forbidden',
      error: WORKSPACE_FAILURE_MESSAGES.forbidden,
    });
    expect(revalidated).toEqual([]);
    // Gone meanwhile (deleted elsewhere): the list is refreshed so it disappears.
    api.DELETE.mockResolvedValueOnce(problem(404));
    expect(await deleteWorkspaceAction(WS_ID)).toMatchObject({ ok: false, failure: 'notFound' });
    expect(revalidated).toEqual([['/workspaces']]);
  });

  it('forwards a well-formed Idempotency-Key on archive/restore only', async () => {
    api.POST.mockResolvedValue(ok(workspace));
    await archiveWorkspaceAction(WS_ID, KEY);
    await restoreWorkspaceAction(WS_ID, KEY);
    for (const path of [
      '/api/v1/workspaces/{workspace_id}/archive',
      '/api/v1/workspaces/{workspace_id}/restore',
    ]) {
      expect(api.POST).toHaveBeenCalledWith(path, {
        params: { path: { workspace_id: WS_ID }, header: { 'Idempotency-Key': KEY } },
      });
    }
    api.POST.mockClear();
    await archiveWorkspaceAction(WS_ID, 'bad key\r\n');
    expect(api.POST).toHaveBeenCalledWith('/api/v1/workspaces/{workspace_id}/archive', {
      params: { path: { workspace_id: WS_ID } },
    });
  });

  it('rejects non-UUID ids locally', async () => {
    expect(await deleteWorkspaceAction('e2e-ws')).toMatchObject({ ok: false, failure: 'notFound' });
    expect(api.DELETE).not.toHaveBeenCalled();
  });
});

describe('requireWorkspace (workspace layout access check)', () => {
  it('returns the workspace the API shows the caller', async () => {
    api.GET.mockResolvedValue(ok(workspace));
    await expect(requireWorkspace(WS_ID)).resolves.toEqual(workspace);
  });

  it('renders not-found for unknown/foreign/deleted ids and non-UUIDs', async () => {
    api.GET.mockResolvedValue(problem(404));
    await expect(requireWorkspace(WS_ID)).rejects.toThrow('NOT_FOUND');
    await expect(requireWorkspace('e2e-ws')).rejects.toThrow('NOT_FOUND');
    expect(api.GET).toHaveBeenCalledTimes(1);
  });

  it('sends expired sessions to /login and surfaces outages as errors', async () => {
    api.GET.mockResolvedValueOnce(problem(401));
    await expect(requireWorkspace(WS_ID)).rejects.toThrow(
      `REDIRECT /login?next=${encodeURIComponent(`/workspaces/${WS_ID}/documents`)}`,
    );
    api.GET.mockResolvedValueOnce(problem(503));
    await expect(requireWorkspace(WS_ID)).rejects.toThrow('HTTP 503');
  });
});
