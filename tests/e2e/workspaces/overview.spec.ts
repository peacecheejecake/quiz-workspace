// WS-01 — Workspace 목록·관리 (`/workspaces`), docs/screens/workspaces.md.
//
// Every test signs in its own userFactory user through /login in a cookie-less context and works
// on its own workspaces (created through the public API by workspaceFactory, or through the UI
// in AC02); teardown purges them. Server-side outcomes follow implementation-plan §7: invisible
// (foreign / soft-deleted / unknown) → 404 with one body; archived write → 403 workspace-archived.
// AC06's UI target (WS-SHARE-01) and the share-links API arrive with S1a/S2a.
import {
  ARCHIVE_ACTION,
  chooseWorkspaceAction,
  DELETE_ACTION,
  expect,
  main,
  notFoundHeading,
  PROBLEM_TYPES,
  SHARE_ACTION,
  signInAs,
  test,
  uniqueWorkspaceName,
  wsUi,
  type ApiResponse,
  type Problem,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const RANDOM_ID = '00000000-0000-4000-8000-000000000000';

/** Problem body without per-request fields, for "same 404 as a missing workspace" checks. */
function stable(res: ApiResponse): Partial<Problem> {
  const { type, title, status, detail } = (res.body ?? {}) as Problem;
  return { type, title, status, detail };
}

test(
  'WS-01-AC01 a signed-in user without workspaces sees the empty state and a create CTA',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const member = await workspaceFactory.member('ws01-ac01');

    await signInAs(page, member.user);
    await page.goto('/workspaces');
    await expect(wsUi.emptyState(page)).toBeVisible();
    await expect(wsUi.createButton(page)).toBeEnabled();
    await expect(main(page).getByRole('listitem')).toHaveCount(0);
    expect(await workspaceFactory.list(member, 'active')).toEqual([]);
  },
);

test(
  'WS-01-AC02 creating a workspace makes the creator its Owner and lists it under Active',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const member = await workspaceFactory.member('ws01-ac02');
    await signInAs(page, member.user);
    await page.goto('/workspaces');

    const name = uniqueWorkspaceName('ws01-ac02');
    await wsUi.createButton(page).click();
    const dialog = wsUi.createDialog(page);
    await wsUi.nameField(dialog).fill(name);
    await wsUi.submitCreate(dialog).click();
    await expect(dialog).toBeHidden();

    await expect(wsUi.activeTab(page)).toHaveAttribute('aria-selected', 'true');
    const item = wsUi.item(wsUi.tabPanel(page), name);
    await expect(item).toBeVisible();
    await expect(wsUi.ownerBadge(item)).toBeVisible();

    // The server agrees: one active workspace, owned by the creator; survives a reload.
    const active = await workspaceFactory.list(member, 'active');
    expect(active.map((w) => ({ name: w.name, role: w.role, status: w.status }))).toEqual([
      { name, role: 'owner', status: 'active' },
    ]);
    await page.reload();
    await expect(wsUi.item(wsUi.tabPanel(page), name)).toBeVisible();
  },
);

test(
  'WS-01-AC03 an archived workspace moves to the Archived tab and its write APIs are rejected',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ws01-ac03');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('ws01-ac03'));
    await signInAs(page, owner.user);
    await page.goto('/workspaces');

    await chooseWorkspaceAction(page, wsUi.item(wsUi.tabPanel(page), ws.name), ARCHIVE_ACTION);
    await expect(wsUi.item(wsUi.tabPanel(page), ws.name)).toHaveCount(0);
    await wsUi.archivedTab(page).click();
    await expect(wsUi.item(wsUi.tabPanel(page), ws.name)).toBeVisible();

    expect((await workspaceFactory.list(owner, 'archived')).map((w) => w.id)).toEqual([ws.id]);
    // Read-only on the server, whatever the UI shows: rename and upload-intent are refused.
    const rename = await owner.api.request('PATCH', `/workspaces/${ws.id}`, { name: 'renamed' });
    expect(rename.status).toBe(403);
    expect((rename.body as Problem).type).toBe(PROBLEM_TYPES.workspaceArchived);
    const upload = await owner.api.request('POST', `/workspaces/${ws.id}/documents/upload-intent`, {
      filename: 'a.pdf',
      size_bytes: 1024,
      content_type: 'application/pdf',
    });
    expect(upload.status).toBe(403);
    expect((upload.body as Problem).type).toBe(PROBLEM_TYPES.workspaceArchived);
    // Reads still work.
    expect((await workspaceFactory.list(owner, 'archived'))[0]?.name).toBe(ws.name);
  },
);

test(
  'WS-01-AC04 a soft-deleted workspace leaves the lists and its old URLs are blocked',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ws01-ac04');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('ws01-ac04'));
    await signInAs(page, owner.user);
    await page.goto('/workspaces');

    await chooseWorkspaceAction(page, wsUi.item(wsUi.tabPanel(page), ws.name), DELETE_ACTION);
    const confirm = page.getByRole('alertdialog');
    await confirm.getByRole('button', { name: /^(삭제|delete)$/i }).click();
    await expect(wsUi.item(wsUi.tabPanel(page), ws.name)).toHaveCount(0);
    await wsUi.archivedTab(page).click();
    await expect(wsUi.item(wsUi.tabPanel(page), ws.name)).toHaveCount(0);

    expect(await workspaceFactory.list(owner, 'active')).toEqual([]);
    expect(await workspaceFactory.list(owner, 'archived')).toEqual([]);

    // Old URL: not-found page with HTTP 404, the name is not rendered.
    const res = await page.goto(`/workspaces/${ws.id}/documents`);
    expect(res?.status()).toBe(404);
    await expect(notFoundHeading(page)).toBeVisible();
    await expect(page.getByText(ws.name)).toHaveCount(0);

    // Old id on the API: same 404 as a workspace that never existed.
    const gone = await owner.api.request('PATCH', `/workspaces/${ws.id}`, { name: 'x' });
    const never = await owner.api.request('PATCH', `/workspaces/${RANDOM_ID}`, { name: 'x' });
    expect(gone.status).toBe(404);
    expect(stable(gone)).toEqual(stable(never));
    expect((gone.body as Problem).detail).toBeTruthy();
  },
);

test(
  "WS-01-AC05 another user's workspace id is rejected by the server and never rendered",
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ws01-ac05-owner');
    const stranger = await workspaceFactory.member('ws01-ac05-stranger');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('ws01-ac05'));

    const never = await stranger.api.request('PATCH', `/workspaces/${RANDOM_ID}`, { name: 'x' });
    expect(never.status).toBe(404);
    for (const [method, path, body] of [
      ['PATCH', `/workspaces/${ws.id}`, { name: 'hijacked' }],
      ['POST', `/workspaces/${ws.id}/archive`, undefined],
      ['DELETE', `/workspaces/${ws.id}`, undefined],
      ['GET', `/workspaces/${ws.id}/documents`, undefined],
    ] as const) {
      const res = await stranger.api.request(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(stable(res), `${method} ${path}`).toEqual(stable(never));
      expect(res.text).not.toContain(ws.name);
    }
    expect(await workspaceFactory.list(stranger, 'active')).toEqual([]);
    // The owner's workspace is untouched.
    const mine = await workspaceFactory.list(owner, 'active');
    expect(mine.map((w) => [w.id, w.name])).toEqual([[ws.id, ws.name]]);

    await signInAs(page, stranger.user);
    const res = await page.goto(`/workspaces/${ws.id}/documents`);
    expect(res?.status()).toBe(404);
    await expect(notFoundHeading(page)).toBeVisible();
    await expect(page.getByText(ws.name)).toHaveCount(0);
  },
);

test(
  'WS-01-AC06 the Owner share menu opens WS-SHARE-01 and others cannot reach the sharing API',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ws01-ac06-owner');
    const stranger = await workspaceFactory.member('ws01-ac06-stranger');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('ws01-ac06'));

    await signInAs(page, owner.user);
    await page.goto('/workspaces');
    await chooseWorkspaceAction(page, wsUi.item(wsUi.tabPanel(page), ws.name), SHARE_ACTION);
    await expect(page).toHaveURL((url) => url.pathname === `/workspaces/${ws.id}/settings/sharing`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/공유|sharing/i);

    // docs/workspace-sharing.md §5: owner-only share-link API.
    const own = await owner.api.request('GET', `/workspaces/${ws.id}/share-links`);
    expect(own.status, 'owner reads share links').toBe(200);
    for (const [method, path] of [
      ['GET', `/workspaces/${ws.id}/share-links`],
      ['POST', `/workspaces/${ws.id}/share-links`],
    ] as const) {
      const res = await stranger.api.request(method, path, method === 'POST' ? {} : undefined);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  },
);
