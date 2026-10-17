// @vitest-environment jsdom
// WS-SHARE-01 WorkspaceSharingPanel: the one-time URL lives only in component state, policy
// controls save on change, revoke/rotate are confirmed and archived workspaces get no
// create/rotate. Server actions are mocked; the API stays the authority in E2E.
import './dom-setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@quiz/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareActionResult } from '../src/lib/sharing/actions';
import type { ShareLink } from '../src/lib/sharing/model';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const actions = {
  create: vi.fn<(...args: unknown[]) => Promise<ShareActionResult>>(),
  update: vi.fn<(...args: unknown[]) => Promise<ShareActionResult>>(),
  revoke: vi.fn<(...args: unknown[]) => Promise<ShareActionResult>>(),
  rotate: vi.fn<(...args: unknown[]) => Promise<ShareActionResult>>(),
};
vi.mock('../src/lib/sharing/actions', () => ({
  createShareLinkAction: (...args: unknown[]) => actions.create(...args),
  updateShareLinkAction: (...args: unknown[]) => actions.update(...args),
  revokeShareLinksAction: (...args: unknown[]) => actions.revoke(...args),
  rotateShareLinkAction: (...args: unknown[]) => actions.rotate(...args),
}));

const { SharingScreen } = await import('../src/components/sharing/sharing-screen');

const WS = '3f2b6f0e-8a4c-4d7e-9a51-1c2d3e4f5a6b';
const L1 = '0b6a5c0e-1d2f-4a3b-8c4d-5e6f7a8b9c0d';
const L2 = '1c7b6d1f-2e3a-4b4c-9d5e-6f7a8b9c0d1e';
const SECRET_1 = 'S'.repeat(43);
const SECRET_2 = 'T'.repeat(43);
const url = (id: string, secret: string) => `http://127.0.0.1:3000/share/${id}#k=${secret}`;

function link(id: string, overrides: Partial<ShareLink> = {}): ShareLink {
  return {
    id,
    workspace_id: WS,
    allow_fork: false,
    expires_at: null,
    revoked_at: null,
    rotated_from_id: null,
    status: 'active',
    created_at: '2026-10-18T00:00:00Z',
    updated_at: '2026-10-18T00:00:00Z',
    ...overrides,
  };
}

function renderScreen(links: ShareLink[], archived = false) {
  return render(
    <ToastProvider>
      <main>
        <SharingScreen
          workspace={{ id: WS, name: '알고리즘', archived }}
          load={{ status: 'ok', links }}
        />
      </main>
    </ToastProvider>,
  );
}

const main = () => screen.getByRole('main');

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

describe('WorkspaceSharingPanel', () => {
  it('starts OFF with notices, then shows the created URL once and only in memory', async () => {
    const user = userEvent.setup();
    actions.create.mockResolvedValue({
      ok: true,
      links: [link(L1)],
      issued: { linkId: L1, shareUrl: url(L1, SECRET_1) },
    });
    renderScreen([]);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('공유 설정');
    const panel = await within(main()).findByRole('dialog', { name: '링크 공유' });
    expect(within(panel).getByText('공유 꺼짐')).toBeVisible();
    expect(within(panel).getByText(/발행된 .*읽기 전용/)).toBeVisible();
    expect(within(panel).getByText(/저작권/)).toBeVisible();
    expect(within(panel).getByRole('switch', { name: 'Fork 허용' })).not.toBeChecked();
    expect(within(panel).queryByRole('button', { name: '링크 철회' })).toBeNull();

    await user.click(within(panel).getByRole('button', { name: '링크 만들기' }));
    const field = await within(panel).findByRole('textbox', { name: '공유 링크' });
    expect(field).toHaveValue(url(L1, SECRET_1));
    expect(field).toHaveAttribute('readonly');
    expect(within(panel).getByText(/한 번만 표시/)).toBeVisible();
    expect(within(panel).getByRole('button', { name: '링크 복사' })).toBeEnabled();
    expect(within(panel).getByText('공유 중')).toBeVisible();

    const [workspaceId, policy, key] = actions.create.mock.calls[0] ?? [];
    expect(workspaceId).toBe(WS);
    expect(policy).toEqual({ allowFork: false, expiresAt: null });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    const stored = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(stored.includes(SECRET_1)).toBe(false);
    expect(window.location.href.includes(SECRET_1)).toBe(false);
  });

  it('saves Fork and expiry changes of the current link on change', async () => {
    const user = userEvent.setup();
    actions.update.mockImplementation(async (_ws, _id, policy) => ({
      ok: true,
      links: [
        link(L1, {
          allow_fork: (policy as { allowFork?: boolean }).allowFork ?? true,
          expires_at: (policy as { expiresAt?: string | null }).expiresAt ?? null,
        }),
      ],
    }));
    renderScreen([link(L1)]);
    const panel = await within(main()).findByRole('dialog', { name: '링크 공유' });
    // No URL after a reload: only the metadata is known.
    expect(within(panel).queryByRole('textbox', { name: '공유 링크' })).toBeNull();

    const fork = within(panel).getByRole('switch', { name: 'Fork 허용' });
    await user.click(fork);
    await waitFor(() => expect(fork).toBeChecked());
    expect(actions.update).toHaveBeenLastCalledWith(WS, L1, { allowFork: true });

    const expiry = within(panel).getByLabelText('만료일');
    const next = new Date(Date.now() + 30 * 86_400_000);
    const date = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    await user.clear(expiry);
    await user.type(expiry, date);
    expect(actions.update).toHaveBeenCalledTimes(1);
    await user.tab();
    await waitFor(() => expect(actions.update).toHaveBeenCalledTimes(2));
    const [, , policy] = actions.update.mock.calls[1] ?? [];
    expect(new Date((policy as { expiresAt: string }).expiresAt).getDate()).toBe(next.getDate());
    await waitFor(() => expect(expiry).toHaveValue(date));
  });

  it('confirms rotate and revoke; revoke turns every active link off', async () => {
    const user = userEvent.setup();
    const other = link(L2, { created_at: '2026-10-01T00:00:00Z' });
    actions.rotate.mockResolvedValue({
      ok: true,
      links: [
        link(L2, { created_at: '2026-10-19T00:00:00Z' }),
        link(L1, { status: 'revoked', revoked_at: '2026-10-19T00:00:00Z' }),
      ],
      issued: { linkId: L2, shareUrl: url(L2, SECRET_2) },
    });
    actions.revoke.mockResolvedValue({
      ok: true,
      links: [link(L2, { status: 'revoked', revoked_at: '2026-10-19T00:00:00Z' })],
    });
    renderScreen([link(L1), other]);
    const panel = await within(main()).findByRole('dialog', { name: '링크 공유' });
    expect(within(panel).getByText(/다른 링크 1개/)).toBeVisible();

    await user.click(within(panel).getByRole('button', { name: '링크 재발급' }));
    const rotateDialog = await screen.findByRole('alertdialog', { name: '링크 재발급' });
    await user.click(within(rotateDialog).getByRole('button', { name: '재발급' }));
    expect(await within(panel).findByRole('textbox', { name: '공유 링크' })).toHaveValue(
      url(L2, SECRET_2),
    );
    expect(actions.rotate).toHaveBeenCalledWith(WS, L1, expect.any(String));

    await user.click(within(panel).getByRole('button', { name: '링크 철회' }));
    const revokeDialog = await screen.findByRole('alertdialog', { name: '링크 철회' });
    await user.click(within(revokeDialog).getByRole('button', { name: '철회' }));
    expect(await within(panel).findByText('철회됨')).toBeVisible();
    expect(within(panel).queryByRole('textbox', { name: '공유 링크' })).toBeNull();
    expect(actions.revoke).toHaveBeenCalledWith(WS, [L2]);
  });

  it('archived: no create or rotate, but policy edits and revoke stay available', async () => {
    renderScreen([link(L1)], true);
    const panel = await within(main()).findByRole('dialog', { name: '링크 공유' });
    expect(within(panel).queryByRole('button', { name: '링크 만들기' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: '링크 재발급' })).toBeNull();
    expect(within(panel).getByRole('button', { name: '링크 철회' })).toBeEnabled();
    expect(within(panel).getByRole('switch', { name: 'Fork 허용' })).toBeEnabled();
  });

  it('an expired link stays editable (also archived): a later expiry reopens it', async () => {
    const user = userEvent.setup();
    const past = '2026-10-01T14:59:59.999Z';
    actions.update.mockImplementation(async (_ws, _id, policy) => ({
      ok: true,
      links: [link(L1, { expires_at: (policy as { expiresAt: string }).expiresAt })],
    }));
    renderScreen([link(L1, { status: 'expired', expires_at: past })], true);
    const panel = await within(main()).findByRole('dialog', { name: '링크 공유' });
    expect(within(panel).getByText('만료됨')).toBeVisible();
    expect(within(panel).queryByText('공유 중')).toBeNull();
    expect(within(panel).queryByRole('button', { name: '링크 재발급' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: '링크 만들기' })).toBeNull();
    expect(within(panel).getByRole('button', { name: '링크 철회' })).toBeEnabled();
    expect(within(panel).getByRole('switch', { name: 'Fork 허용' })).toBeEnabled();

    const expiry = within(panel).getByLabelText('만료일');
    expect(expiry).toBeEnabled();
    const next = new Date(Date.now() + 7 * 86_400_000);
    const date = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    await user.clear(expiry);
    await user.type(expiry, date);
    await user.tab();
    await waitFor(() => expect(actions.update).toHaveBeenCalledTimes(1));
    expect(actions.update.mock.calls[0]?.[1]).toBe(L1);
    expect(await within(panel).findByText('공유 중')).toBeVisible();
  });

  it('revoke covers the managed link and every other non-revoked link', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 24 }, (_, i) =>
      link(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, {
        created_at: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      }),
    );
    actions.revoke.mockResolvedValue({ ok: true, links: [] });
    renderScreen([
      link(L1),
      link(L2, { status: 'expired', created_at: '2026-10-17T00:00:00Z' }),
      ...many,
    ]);
    const panel = await within(main()).findByRole('dialog', { name: '링크 공유' });
    await user.click(within(panel).getByRole('button', { name: '링크 철회' }));
    const dialog = await screen.findByRole('alertdialog', { name: '링크 철회' });
    await user.click(within(dialog).getByRole('button', { name: '철회' }));
    await waitFor(() => expect(actions.revoke).toHaveBeenCalledTimes(1));
    const sent = actions.revoke.mock.calls[0]?.[1] as string[];
    expect(sent).toHaveLength(26);
    expect(new Set(sent)).toEqual(new Set([L1, L2, ...many.map((l) => l.id)]));
  });

  it('archived without a link: nothing to create, controls disabled', async () => {
    renderScreen([], true);
    const panel = await within(main()).findByRole('dialog', { name: '링크 공유' });
    expect(within(panel).queryByRole('button', { name: '링크 만들기' })).toBeNull();
    expect(within(panel).getByRole('switch', { name: 'Fork 허용' })).toBeDisabled();
  });

  it('an idempotent replay without a secret shows no URL and suggests rotating', async () => {
    const user = userEvent.setup();
    actions.create.mockResolvedValue({ ok: true, links: [link(L1)], secretAlreadyIssued: true });
    renderScreen([]);
    const panel = await within(main()).findByRole('dialog', { name: '링크 공유' });
    await user.click(within(panel).getByRole('button', { name: '링크 만들기' }));
    expect(await within(panel).findByText(/이미 표시되었습니다/)).toBeVisible();
    expect(within(panel).queryByRole('textbox', { name: '공유 링크' })).toBeNull();
  });

  it('shows API failures as an alert and keeps the refreshed list', async () => {
    const user = userEvent.setup();
    actions.create.mockResolvedValue({
      ok: false,
      failure: 'archived',
      error: '보관된 Workspace에서는 새 링크를 만들거나 재발급할 수 없습니다.',
      links: [],
    });
    renderScreen([]);
    const panel = await within(main()).findByRole('dialog', { name: '링크 공유' });
    await user.click(within(panel).getByRole('button', { name: '링크 만들기' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/보관된 Workspace/);
  });
});
