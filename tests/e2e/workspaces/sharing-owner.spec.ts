// WS-SHARE-01 — Owner Workspace 공유 관리 (`/workspaces/:workspaceId/settings/sharing`),
// docs/screens/workspace-sharing.md, docs/workspace-sharing.md §1–§5.
//
// Every test signs in its own owner through /login in a cookie-less context and shares its own
// workspace. Each test touches the share-link API first, so until S1a the failure names the
// missing route. Guest sessions are opened with Node fetch (fixtures/sharing.ts ShareSession),
// so secrets and cookies never reach a trace; secrets are compared with booleans only, and the
// spec runs without trace/screenshot/video (the one-time secret URL is on screen). API and UI
// label assumptions: fixtures/sharing.ts header (S1–S9 + UI contract + artifact hygiene).
import type { Locator } from '@playwright/test';
import {
  notFoundHeading,
  PROBLEM_TYPES,
  seedMembership,
  signInAs,
  uniqueWorkspaceName,
  type Problem,
} from '../fixtures/test.ts';
import {
  createShareLink,
  exchangeRequest,
  expect,
  expectNoSecret,
  listShareLinks,
  membershipsOf,
  NO_VISUAL_ARTIFACTS,
  registerShareSecret,
  revokeShareLink,
  secretBytes,
  shareLinkRow,
  ShareSession,
  sharingSettingsPath,
  sharingUi,
  stableProblem,
  test,
  updateShareLink,
  type ShareLink,
} from '../fixtures/sharing.ts';

test.use({ storageState: { cookies: [], origins: [] }, ...NO_VISUAL_ARTIFACTS });

const RANDOM_ID = '00000000-0000-4000-8000-000000000000';
const SHARE_URL = /\/share\/([0-9a-f-]{36})#k=([A-Za-z0-9_-]+)$/;

/**
 * Waits for the one-time link field to hold a share URL and returns [linkId, secret]. Checked as a
 * boolean: `toHaveValue` would print the secret URL on failure.
 */
async function readShareUrl(field: Locator): Promise<[string, string]> {
  await expect
    .poll(async () => SHARE_URL.test(await field.inputValue({ timeout: 1_000 }).catch(() => '')), {
      message: 'the link field shows /share/{id}#k={secret}',
    })
    .toBe(true);
  const [, linkId = '', secret = ''] = SHARE_URL.exec(await field.inputValue()) ?? [];
  return [linkId, registerShareSecret(secret)];
}

/** `YYYY-MM-DD` `days` from now in Asia/Seoul (the pinned browser timezone). */
function seoulDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toLocaleDateString('sv-SE', {
    timeZone: 'Asia/Seoul',
  });
}

/** True when an ISO timestamp falls within a day of the Seoul calendar date `date`. */
function nearDate(iso: string | null, date: string): boolean {
  if (!iso) return false;
  const delta = Math.abs(Date.parse(iso) - Date.parse(`${date}T00:00:00+09:00`));
  return delta <= 36 * 3_600_000;
}

test(
  'WS-SHARE-01-AC01 opening sharing shows it OFF, the scope and copyright notices and Fork OFF',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('share01-ac01');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('share01-ac01'));
    expect(await listShareLinks(owner, ws.id), 'no link before the owner creates one').toEqual([]);

    await signInAs(page, owner.user);
    await page.goto(sharingSettingsPath(ws.id));
    await expect(sharingUi.heading(page)).toHaveText(/공유|sharing/i);
    await expect(sharingUi.offStatus(page)).toBeVisible();
    await expect(sharingUi.scopeNotice(page)).toBeVisible();
    await expect(sharingUi.copyrightNotice(page)).toBeVisible();
    await expect(sharingUi.forkSwitch(page)).not.toBeChecked();
    await expect(sharingUi.createButton(page)).toBeEnabled();
    await expect(sharingUi.revokeButton(page)).toHaveCount(0);
    // Opening the screen creates nothing.
    expect(await listShareLinks(owner, ws.id)).toEqual([]);
  },
);

test(
  'WS-SHARE-01-AC02 creating a link shows the view-only secret URL once, copyable, and adds no member',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('share01-ac02');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('share01-ac02'));
    expect(await listShareLinks(owner, ws.id)).toEqual([]);

    await signInAs(page, owner.user);
    await page.goto(sharingSettingsPath(ws.id));
    await sharingUi.createButton(page).click();
    const field = sharingUi.linkField(page);
    const [linkId, secret] = await readShareUrl(field);
    expect(secretBytes(secret), 'secret carries >= 32 random bytes').toBeGreaterThanOrEqual(32);
    await expect(sharingUi.copyButton(page)).toBeEnabled();
    await expect(sharingUi.onceNotice(page)).toBeVisible();
    await expect(sharingUi.expiry(page)).toBeEditable();
    await expect(sharingUi.forkSwitch(page)).not.toBeChecked();

    // Server: one view-only link, Fork OFF, listed without its secret; DB keeps a digest only.
    const links = await listShareLinks(owner, ws.id);
    expect(links.map((l: ShareLink) => [l.id, l.allow_fork, l.revoked_at])).toEqual([
      [linkId, false, null],
    ]);
    expectNoSecret(JSON.stringify(links), secret, 'the share-link listing');
    const row = shareLinkRow(linkId);
    expectNoSecret(row.json, secret, 'workspace_share_links');
    expect(row.digestBytes, 'SHA-256/HMAC digest').toBe(32);

    // The URL works for a guest, and a guest is never a member.
    const session = await ShareSession.open(linkId, secret);
    expect((await session.workspace()).workspace.name).toBe(ws.name);
    expect(membershipsOf(ws.id)).toEqual([[owner.user.id, 'owner']]);

    // Shown once: after a reload only the metadata is left.
    await page.reload();
    await expect(sharingUi.linkField(page)).toHaveCount(0);
    expectNoSecret(await page.content(), secret, 'the sharing page after reload');
    await expect(sharingUi.revokeButton(page)).toBeVisible();
  },
);

test(
  'WS-SHARE-01-AC03 the Owner changes Fork permission and expiry; other accounts are rejected',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('share01-ac03');
    const stranger = await workspaceFactory.member('share01-ac03-stranger');
    const editor = await workspaceFactory.member('share01-ac03-editor');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('share01-ac03'));
    const link = await createShareLink(owner, ws.id);

    await signInAs(page, owner.user);
    await page.goto(sharingSettingsPath(ws.id));
    await sharingUi.forkSwitch(page).click();
    await expect(sharingUi.forkSwitch(page)).toBeChecked();
    const date = seoulDate(30);
    await sharingUi.expiry(page).fill(date);
    await sharingUi.expiry(page).blur();
    await expect
      .poll(
        async () => {
          const [l] = await listShareLinks(owner, ws.id);
          return l ? l.allow_fork && nearDate(l.expires_at, date) : false;
        },
        { message: 'Fork ON and the expiry are saved' },
      )
      .toBe(true);
    await page.reload();
    await expect(sharingUi.forkSwitch(page)).toBeChecked();
    await expect(sharingUi.expiry(page)).toHaveValue(date);

    // Guests see the policy the owner set.
    const session = await ShareSession.open(link.id, link.secret);
    expect((await session.workspace()).allow_fork).toBe(true);

    // Same API, other accounts: invisible to a stranger, forbidden for a non-owner member.
    seedMembership(ws.id, editor.user.id, 'editor');
    const path = `/workspaces/${ws.id}/share-links/${link.id}`;
    for (const [who, member, status] of [
      ['stranger', stranger, 404],
      ['editor', editor, 403],
    ] as const) {
      const res = await member.api.request('PATCH', path, { allow_fork: false, expires_at: null });
      expect(res.status, `${who} PATCH`).toBe(status);
      if (status === 403) {
        expect((res.body as Problem).type).toBe(PROBLEM_TYPES.insufficientRole);
      }
    }
    const [after] = await listShareLinks(owner, ws.id);
    expect(after?.allow_fork, 'rejected requests changed nothing').toBe(true);
    expect(nearDate(after?.expires_at ?? null, date)).toBe(true);
  },
);

test(
  'WS-SHARE-01-AC04 revoke and rotate invalidate the old URL and live share sessions at once',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('share01-ac04');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('share01-ac04'));
    const first = await createShareLink(owner, ws.id);
    const firstSession = await ShareSession.open(first.id, first.secret);
    const never = await exchangeRequest(RANDOM_ID, first.secret);

    await signInAs(page, owner.user);
    await page.goto(sharingSettingsPath(ws.id));
    await sharingUi.rotateButton(page).click();
    await sharingUi.confirmButton(sharingUi.confirmDialog(page)).click();
    const field = sharingUi.linkField(page);
    const [secondId, secondSecret] = await readShareUrl(field);
    expect(secondId).not.toBe(first.id);
    expect(secondSecret === first.secret, 'rotate issues a new secret').toBe(false);

    // The old session dies on its next request; the old URL is a generic unavailable link.
    expect((await firstSession.get()).status, 'old session after rotate').toBe(404);
    const oldExchange = await exchangeRequest(first.id, first.secret);
    expect(oldExchange.status).toBe(404);
    expect(stableProblem(oldExchange)).toEqual(stableProblem(never));

    const secondSession = await ShareSession.open(secondId, secondSecret);
    expect((await secondSession.get()).status).toBe(200);
    await sharingUi.revokeButton(page).click();
    await sharingUi.confirmButton(sharingUi.confirmDialog(page)).click();
    await expect(sharingUi.revokedStatus(page)).toBeVisible();
    await expect(sharingUi.linkField(page)).toHaveCount(0);
    expect((await secondSession.get()).status, 'session after revoke').toBe(404);
    expect((await exchangeRequest(secondId, secondSecret)).status).toBe(404);
    expect((await listShareLinks(owner, ws.id)).every((l) => l.revoked_at !== null)).toBe(true);
  },
);

test(
  'WS-SHARE-01-AC05 archived workspaces allow only revoke and policy edits; deleted ones kill links',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('share01-ac05');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('share01-ac05'));
    const link = await createShareLink(owner, ws.id);
    const session = await ShareSession.open(link.id, link.secret);
    await workspaceFactory.archive(owner, ws.id);

    // API: no new or rotated links on an archived workspace; policy and revoke still work.
    for (const [path, what] of [
      [`/workspaces/${ws.id}/share-links`, 'create'],
      [`/workspaces/${ws.id}/share-links/${link.id}/rotate`, 'rotate'],
    ] as const) {
      const res = await owner.api.request('POST', path, {});
      expect(res.status, what).toBe(403);
      expect((res.body as Problem).type, what).toBe(PROBLEM_TYPES.workspaceArchived);
    }
    expect((await updateShareLink(owner, ws.id, link.id, { allow_fork: true })).allow_fork).toBe(
      true,
    );
    expect((await session.get()).status, 'archived stays readable until revoked').toBe(200);

    await signInAs(page, owner.user);
    await page.goto(sharingSettingsPath(ws.id));
    await expect(sharingUi.forkSwitch(page)).toBeEnabled();
    await expect(sharingUi.createButton(page).or(sharingUi.rotateButton(page))).toHaveCount(0);
    await sharingUi.revokeButton(page).click();
    await sharingUi.confirmButton(sharingUi.confirmDialog(page)).click();
    await expect(sharingUi.revokedStatus(page)).toBeVisible();
    expect((await session.get()).status, 'revoked on archived').toBe(404);

    // Soft-deleted: the link and its live session are unusable, the settings route is gone.
    const doomed = await workspaceFactory.create(owner, uniqueWorkspaceName('share01-ac05-del'));
    const doomedLink = await createShareLink(owner, doomed.id);
    const doomedSession = await ShareSession.open(doomedLink.id, doomedLink.secret);
    await workspaceFactory.softDelete(owner, doomed.id);
    const never = await exchangeRequest(RANDOM_ID, doomedLink.secret);
    const exchange = await exchangeRequest(doomedLink.id, doomedLink.secret);
    expect(exchange.status).toBe(404);
    expect(stableProblem(exchange)).toEqual(stableProblem(never));
    expect((await doomedSession.get()).status).toBe(404);
    expect((await owner.api.request('GET', `/workspaces/${doomed.id}/share-links`)).status).toBe(
      404,
    );
    const res = await page.goto(sharingSettingsPath(doomed.id));
    expect(res?.status()).toBe(404);
    await expect(notFoundHeading(page)).toBeVisible();
    // revokeShareLink on a deleted workspace is 404 like any invisible resource.
    await expect(revokeShareLink(owner, doomed.id, doomedLink.id)).rejects.toThrow(/404/);
  },
);
