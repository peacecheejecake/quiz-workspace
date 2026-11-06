// @vitest-environment jsdom
// WS-SHARE-01 WorkspaceSharingPanel (the home's "링크 공유" dialog, UX3c): it opens at once with a
// skeleton while the links load, the one-time URL lives only in component state, policy controls
// save on change, revoke/rotate are confirmed and archived workspaces get no create/rotate.
// Server actions are mocked; the API stays the authority in E2E.
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
  list: vi.fn<(...args: unknown[]) => Promise<ShareActionResult>>(),
  create: vi.fn<(...args: unknown[]) => Promise<ShareActionResult>>(),
  update: vi.fn<(...args: unknown[]) => Promise<ShareActionResult>>(),
  revoke: vi.fn<(...args: unknown[]) => Promise<ShareActionResult>>(),
  rotate: vi.fn<(...args: unknown[]) => Promise<ShareActionResult>>(),
};
vi.mock('../src/lib/sharing/actions', () => ({
  listShareLinksAction: (...args: unknown[]) => actions.list(...args),
  createShareLinkAction: (...args: unknown[]) => actions.create(...args),
  updateShareLinkAction: (...args: unknown[]) => actions.update(...args),
  revokeShareLinksAction: (...args: unknown[]) => actions.revoke(...args),
  rotateShareLinkAction: (...args: unknown[]) => actions.rotate(...args),
}));

const { WorkspaceSharingPanel } = await import('../src/components/sharing/workspace-sharing-panel');

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
    include_notes: true,
    include_ai_explanations: true,
    include_summary: true,
    include_owner_records: false,
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
  actions.list.mockResolvedValue({ ok: true, links });
  return render(
    <ToastProvider>
      <main>
        <WorkspaceSharingPanel
          workspaceId={WS}
          archived={archived}
          open
          onOpenChange={vi.fn()}
          container={null}
          screenId="WS-SHARE-01"
        />
      </main>
    </ToastProvider>,
  );
}

/** The dialog once its links have loaded (it opens at once with a skeleton). */
async function loadedPanel() {
  const panel = await screen.findByRole('dialog', { name: '링크 공유' });
  await within(panel).findByRole('switch', { name: 'Fork 허용' });
  return panel;
}

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

describe('WorkspaceSharingPanel', () => {
  it('starts OFF with notices, then shows the created URL in memory without web storage', async () => {
    const user = userEvent.setup();
    actions.create.mockResolvedValue({
      ok: true,
      links: [link(L1, { share_url: url(L1, SECRET_1) })],
      issued: { linkId: L1, shareUrl: url(L1, SECRET_1) },
    });
    renderScreen([]);

    const panel = await loadedPanel();
    expect(actions.list).toHaveBeenCalledWith(WS);
    expect(within(panel).getByText('공유 꺼짐')).toBeVisible();
    expect(within(panel).getByText(/발행된 .*읽기 전용/)).toBeVisible();
    expect(within(panel).getByText(/저작권/)).toBeVisible();
    expect(within(panel).getByRole('switch', { name: 'Fork 허용' })).not.toBeChecked();
    expect(within(panel).queryByRole('button', { name: '링크 철회' })).toBeNull();

    await user.click(within(panel).getByRole('button', { name: '링크 만들기' }));
    const field = await within(panel).findByRole('textbox', { name: '공유 링크' });
    expect(field).toHaveValue(url(L1, SECRET_1));
    expect(field).toHaveAttribute('readonly');
    expect(within(panel).getByText(/주소를 바꾸려면 링크를 재발급하세요/)).toBeVisible();
    expect(within(panel).queryByText(/한 번만/)).toBeNull();
    expect(within(panel).getByRole('button', { name: '링크 복사' })).toBeEnabled();
    expect(within(panel).getByText('공유 중')).toBeVisible();
    expect(screen.getByText('보기 전용 링크를 만들었습니다.')).toBeVisible();

    const [workspaceId, policy, key] = actions.create.mock.calls[0] ?? [];
    expect(workspaceId).toBe(WS);
    expect(policy).toEqual({
      allowFork: false,
      expiresAt: null,
      scope: {
        include_notes: true,
        include_ai_explanations: true,
        include_summary: true,
        include_owner_records: false,
      },
    });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    const stored = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(stored.includes(SECRET_1)).toBe(false);
    expect(window.location.href.includes(SECRET_1)).toBe(false);
  });

  it('shows the existing share_url across remount/reload until revoked, and falls back cleanly for legacy links', async () => {
    const firstRender = renderScreen([link(L1, { share_url: url(L1, SECRET_1) })]);
    let panel = await loadedPanel();
    expect(within(panel).getByRole('textbox', { name: '공유 링크' })).toHaveValue(
      url(L1, SECRET_1),
    );
    expect(within(panel).getByRole('button', { name: '링크 복사' })).toBeEnabled();
    expect(within(panel).queryByText(/한 번만/)).toBeNull();
    expect(JSON.stringify({ ...localStorage, ...sessionStorage }).includes(SECRET_1)).toBe(false);
    firstRender.unmount();

    // Remounting (dialog close/reopen or reload) keeps showing the URL, even if expired (not revoked).
    const secondRender = renderScreen([
      link(L1, {
        status: 'expired',
        expires_at: '2026-10-01T14:59:59.999Z',
        share_url: url(L1, SECRET_1),
      }),
    ]);
    panel = await loadedPanel();
    expect(within(panel).getByRole('textbox', { name: '공유 링크' })).toHaveValue(
      url(L1, SECRET_1),
    );
    expect(within(panel).getByRole('button', { name: '링크 복사' })).toBeEnabled();
    secondRender.unmount();

    // Legacy link (share_url: null) shows no textbox and guides the owner to rotate.
    renderScreen([link(L1, { share_url: null })]);
    panel = await loadedPanel();
    expect(within(panel).queryByRole('textbox', { name: '공유 링크' })).toBeNull();
    expect(
      within(panel).getByText(/이전에 만든 링크라 주소를 다시 불러올 수 없습니다/),
    ).toBeVisible();
  });

  it('saves Fork and expiry changes of the current link on change', async () => {
    const user = userEvent.setup();
    actions.update.mockImplementation(async (_ws, _id, policy) => ({
      ok: true,
      links: [
        link(L1, {
          allow_fork: (policy as { allowFork?: boolean }).allowFork ?? true,
          expires_at: (policy as { expiresAt?: string | null }).expiresAt ?? null,
          share_url: url(L1, SECRET_1),
        }),
      ],
    }));
    renderScreen([link(L1, { share_url: url(L1, SECRET_1) })]);
    const panel = await loadedPanel();
    expect(within(panel).getByRole('textbox', { name: '공유 링크' })).toHaveValue(
      url(L1, SECRET_1),
    );

    const fork = within(panel).getByRole('switch', { name: 'Fork 허용' });
    await user.click(fork);
    await waitFor(() => expect(fork).toBeChecked());
    expect(actions.update).toHaveBeenLastCalledWith(WS, L1, { allowFork: true });

    const expiry = within(panel).getByLabelText('만료일');
    const next = new Date(Date.now() + 30 * 86_400_000);
    const date = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    await waitFor(() => expect(expiry).toBeEnabled());
    await user.clear(expiry);
    await user.type(expiry, date);
    expect(actions.update).toHaveBeenCalledTimes(1);
    // The next stop is 만료일 삭제 (no save yet); leaving it saves the edited date.
    await user.tab();
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
    const panel = await loadedPanel();
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
    const panel = await loadedPanel();
    expect(within(panel).queryByRole('button', { name: '링크 만들기' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: '링크 재발급' })).toBeNull();
    expect(within(panel).getByRole('button', { name: '링크 철회' })).toBeEnabled();
    expect(within(panel).getByRole('switch', { name: 'Fork 허용' })).toBeEnabled();
  });

  describe('WS-SHARE-01-AC06 clearing right after editing the date (review P2)', () => {
    const SAVED = '2099-01-31T14:59:59.999Z';
    const next = new Date(Date.now() + 20 * 86_400_000);
    const date = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;

    async function editDate() {
      actions.update.mockImplementation(async (_ws, _id, policy) => ({
        ok: true,
        links: [link(L1, { expires_at: (policy as { expiresAt: string | null }).expiresAt })],
      }));
      renderScreen([link(L1, { expires_at: SAVED })]);
      const panel = await loadedPanel();
      const expiry = within(panel).getByLabelText('만료일');
      const user = userEvent.setup();
      await user.clear(expiry);
      await user.type(expiry, date);
      expect(expiry).toHaveFocus();
      return { panel, user };
    }

    it('a click on 만료일 삭제 from the focused, edited field saves null, not the draft', async () => {
      const { panel, user } = await editDate();
      await user.click(within(panel).getByRole('button', { name: '만료일 삭제' }));
      await waitFor(() => expect(within(panel).getByText(/^만료 없음/)).toBeVisible());
      expect(actions.update.mock.calls).toEqual([[WS, L1, { expiresAt: null }]]);
    });

    it('Tab to 만료일 삭제 then Enter saves null, not the draft', async () => {
      const { panel, user } = await editDate();
      await user.tab();
      expect(within(panel).getByRole('button', { name: '만료일 삭제' })).toHaveFocus();
      expect(actions.update).not.toHaveBeenCalled();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(within(panel).getByText(/^만료 없음/)).toBeVisible());
      expect(actions.update.mock.calls).toEqual([[WS, L1, { expiresAt: null }]]);
    });

    it('tabbing past 만료일 삭제 without clearing still saves the edited date', async () => {
      const { panel, user } = await editDate();
      await user.tab();
      await user.tab();
      await waitFor(() => expect(actions.update).toHaveBeenCalledTimes(1));
      const [, , policy] = actions.update.mock.calls[0] ?? [];
      expect((policy as { expiresAt: string }).expiresAt).not.toBeNull();
      expect(within(panel).queryByText(/^만료 없음/)).toBeNull();
    });
  });

  it('WS-SHARE-01-AC06 a failed clear keeps the saved date and the clear button (review P2)', async () => {
    const user = userEvent.setup();
    const saved = link(L1, { expires_at: '2099-01-31T14:59:59.999Z' });
    actions.update.mockResolvedValue({
      ok: false,
      failure: 'unavailable',
      error: '연결할 수 없습니다.',
      links: [saved],
    });
    renderScreen([saved]);
    const panel = await loadedPanel();
    const expiry = within(panel).getByLabelText('만료일');
    const before = (expiry as HTMLInputElement).value;
    expect(before).not.toBe('');
    await user.click(within(panel).getByRole('button', { name: '만료일 삭제' }));
    await waitFor(() => expect(actions.update).toHaveBeenCalledTimes(1));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('연결할 수 없습니다.');
    await waitFor(() => expect(expiry).toHaveValue(before));
    expect(within(panel).queryByText(/^만료 없음/)).toBeNull();
    expect(within(panel).getByRole('button', { name: '만료일 삭제' })).toBeEnabled();
  });

  it('WS-SHARE-01-AC06 clears a saved expiry: PATCH null, "만료 없음", focus on the date', async () => {
    const user = userEvent.setup();
    actions.update.mockResolvedValue({ ok: true, links: [link(L1, { expires_at: null })] });
    renderScreen([link(L1, { expires_at: '2099-01-31T14:59:59.999Z' })], true);
    const panel = await loadedPanel();
    expect(within(panel).queryByText(/^만료 없음/)).toBeNull();
    const clear = within(panel).getByRole('button', { name: '만료일 삭제' });
    clear.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(actions.update).toHaveBeenCalledTimes(1));
    expect(actions.update).toHaveBeenLastCalledWith(WS, L1, { expiresAt: null });
    expect(await within(panel).findByText(/^만료 없음/)).toBeVisible();
    expect(within(panel).getByLabelText('만료일')).toHaveValue('');
    await waitFor(() => expect(within(panel).getByLabelText('만료일')).toHaveFocus());
    expect(within(panel).queryByRole('button', { name: '만료일 삭제' })).toBeNull();
  });

  it('WS-SHARE-01-AC08 a copy shows "복사 완료" instead of a success toast', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    actions.create.mockResolvedValue({
      ok: true,
      links: [link(L1)],
      issued: { linkId: L1, shareUrl: url(L1, SECRET_1) },
    });
    renderScreen([]);
    const panel = await loadedPanel();
    await user.click(within(panel).getByRole('button', { name: '링크 만들기' }));
    await user.click(await within(panel).findByRole('button', { name: '링크 복사' }));
    expect(writeText).toHaveBeenCalledWith(url(L1, SECRET_1));
    expect(await within(panel).findByRole('button', { name: '복사 완료' })).toBeVisible();
    expect(screen.getAllByText('링크를 복사했습니다.')).toHaveLength(1);
  });

  it('an expired link stays editable (also archived): a later expiry reopens it', async () => {
    const user = userEvent.setup();
    const past = '2026-10-01T14:59:59.999Z';
    actions.update.mockImplementation(async (_ws, _id, policy) => ({
      ok: true,
      links: [link(L1, { expires_at: (policy as { expiresAt: string }).expiresAt })],
    }));
    renderScreen([link(L1, { status: 'expired', expires_at: past })], true);
    const panel = await loadedPanel();
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
    // The next stop is 만료일 삭제 (no save yet); leaving it saves the edited date.
    await user.tab();
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
    const panel = await loadedPanel();
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
    const panel = await loadedPanel();
    expect(within(panel).queryByRole('button', { name: '링크 만들기' })).toBeNull();
    expect(within(panel).getByRole('switch', { name: 'Fork 허용' })).toBeDisabled();
  });

  it('an idempotent replay without a secret shows no URL and suggests rotating', async () => {
    const user = userEvent.setup();
    actions.create.mockResolvedValue({ ok: true, links: [link(L1)], secretAlreadyIssued: true });
    renderScreen([]);
    const panel = await loadedPanel();
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
    const panel = await loadedPanel();
    await user.click(within(panel).getByRole('button', { name: '링크 만들기' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/보관된 Workspace/);
  });
});

describe('WorkspaceSharingPanel loading (UX3c)', () => {
  it('opens at once with a skeleton, then shows the links; a failed read offers a retry', async () => {
    const user = userEvent.setup();
    let resolve: (r: ShareActionResult) => void = () => undefined;
    actions.list.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    render(
      <ToastProvider>
        <WorkspaceSharingPanel
          workspaceId={WS}
          archived={false}
          open
          onOpenChange={vi.fn()}
          container={null}
        />
      </ToastProvider>,
    );
    const panel = await screen.findByRole('dialog', { name: '링크 공유' });
    expect(within(panel).getByRole('status')).toHaveTextContent('불러오는 중');
    expect(within(panel).queryByRole('switch', { name: 'Fork 허용' })).toBeNull();
    resolve({ ok: false, failure: 'unavailable', error: '연결할 수 없습니다.' });
    const alert = await within(panel).findByRole('alert');
    actions.list.mockResolvedValueOnce({ ok: true, links: [link(L1)] });
    await user.click(within(alert).getByRole('button', { name: '다시 시도' }));
    expect(await within(panel).findByText('공유 중')).toBeVisible();
  });

  describe('공유 범위 (UX12-SHARE)', () => {
    const region = () => screen.findByRole('region', { name: '공유 범위' });

    it('sends a new link the chosen scope and starts from the defaults', async () => {
      actions.create.mockResolvedValue({ ok: true, links: [] });
      renderScreen([]);
      const scope = await region();
      const owner = within(scope).getByRole('switch', { name: /내 풀이 이력·하이라이트/ });
      expect(owner.getAttribute('aria-checked')).toBe('false');
      for (const name of [/^정리 노트/, /^AI 해설/, /^문서 요약/]) {
        expect(within(scope).getByRole('switch', { name }).getAttribute('aria-checked')).toBe(
          'true',
        );
      }
      await userEvent.click(within(scope).getByRole('switch', { name: /^정리 노트/ }));
      await userEvent.click(screen.getByRole('button', { name: '링크 만들기' }));
      await waitFor(() => expect(actions.create).toHaveBeenCalled());
      expect(actions.create.mock.calls[0]?.[1]).toMatchObject({
        scope: {
          include_notes: false,
          include_ai_explanations: true,
          include_summary: true,
          include_owner_records: false,
        },
      });
    });

    it('saves one flag at a time on an existing link', async () => {
      actions.update.mockResolvedValue({ ok: true, links: [link(L1, { include_summary: false })] });
      renderScreen([link(L1)]);
      const scope = await region();
      await userEvent.click(within(scope).getByRole('switch', { name: /^문서 요약/ }));
      await waitFor(() => expect(actions.update).toHaveBeenCalled());
      expect(actions.update.mock.calls[0]?.[2]).toEqual({ scope: { include_summary: false } });
    });

    it('rewrites the scope notice when owner records are public', async () => {
      renderScreen([link(L1, { include_owner_records: true })]);
      await region();
      const notices = screen.getByRole('region', { name: '공개 범위와 저작권' });
      expect(notices.textContent).toMatch(/내 풀이 이력·하이라이트를 읽기 전용으로/);
      expect(notices.textContent).not.toMatch(/개인 풀이 기록·즐겨찾기는 공개되지/);
    });

    it('keeps the private notice with the option off', async () => {
      renderScreen([link(L1)]);
      await region();
      const notices = screen.getByRole('region', { name: '공개 범위와 저작권' });
      expect(notices.textContent).toMatch(/개인 풀이 기록·즐겨찾기는 공개되지/);
    });
  });
});
