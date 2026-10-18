// @vitest-environment jsdom
// WS-FORK-01 ForkWorkspaceDialog: explains scope/independence/no progress/copyright, refuses a
// blank name locally, reuses the Idempotency-Key for a resend of the same name, and follows the
// fork to COMPLETED (link to the new workspace), FAILED (alert + retry with a new key) or
// CANCELLED (link unavailable).
import './dom-setup';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForkWorkspaceDialog } from '../src/components/shared/fork-workspace-dialog';
import { ForkRequestError, type Fork, type ForkClient } from '../src/lib/shared/fork';

const SHARE = '0b6a5c0e-1d2f-4a3b-8c4d-5e6f7a8b9c0d';
const FORK_ID = '3e9d8f3b-4a5c-4d6e-9f7a-8b9c0d1e2f3a';
const TARGET = '4fae904c-5b6d-4e7f-8a8b-9c0d1e2f3a4b';

function fork(overrides: Partial<Fork> = {}): Fork {
  return {
    id: FORK_ID,
    job_id: FORK_ID,
    status: 'PENDING',
    progress: 0,
    name: '내 사본',
    target_workspace_id: null,
    error_code: null,
    created_at: '2026-10-18T00:00:00Z',
    updated_at: '2026-10-18T00:00:00Z',
    completed_at: null,
    ...overrides,
  };
}

function fakeClient(start: ForkClient['start'], get: ForkClient['get']) {
  return { start: vi.fn(start), get: vi.fn(get) };
}

function renderDialog(client: ForkClient) {
  return render(
    <ForkWorkspaceDialog
      shareId={SHARE}
      screenId="WS-FORK-01"
      open
      onOpenChange={() => undefined}
      sourceName="공유 알고리즘"
      client={client}
    />,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ForkWorkspaceDialog', () => {
  it('explains the fork and refuses a blank name without a request', async () => {
    const client = fakeClient(
      async () => fork(),
      async () => fork(),
    );
    renderDialog(client);
    const dialog = screen.getByRole('dialog', { name: 'Workspace Fork' });
    expect(dialog).toHaveTextContent(/발행된 문서.*해설/);
    expect(dialog).toHaveTextContent(/독립/);
    expect(dialog).toHaveTextContent(/복제되지 않습니다/);
    expect(dialog).toHaveTextContent(/저작권/);
    const name = screen.getByRole('textbox', { name: '새 Workspace 이름' });
    expect(name).toHaveValue('공유 알고리즘');
    expect(name).toHaveFocus();
    await userEvent.clear(name);
    await userEvent.click(screen.getByRole('button', { name: 'Fork 시작' }));
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(client.start).not.toHaveBeenCalled();
  });

  it('shows progress, then completion with a link to the new workspace', async () => {
    const done = fork({ status: 'COMPLETED', progress: 100, target_workspace_id: TARGET });
    const states = [fork({ status: 'COPYING', progress: 40 })];
    const client = fakeClient(
      async () => fork(),
      async () => states.shift() ?? done,
    );
    renderDialog(client);
    await userEvent.click(screen.getByRole('button', { name: 'Fork 시작' }));
    expect(client.start).toHaveBeenCalledWith('공유 알고리즘', expect.any(String));
    expect(await screen.findByRole('progressbar', { name: 'Fork 진행률' })).toBeInTheDocument();
    expect(await screen.findByText('Fork 완료', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '내 사본' })).toHaveAttribute(
      'href',
      `/workspaces/${TARGET}/documents`,
    );
    expect(client.get).toHaveBeenCalledWith(FORK_ID, expect.any(AbortSignal));
  });

  it('resends a lost request with the same key and a new name with a new key', async () => {
    const start = vi
      .fn<ForkClient['start']>()
      .mockRejectedValueOnce(new ForkRequestError('network'))
      .mockRejectedValueOnce(new ForkRequestError('rateLimited', 429, 3))
      .mockResolvedValue(fork({ status: 'COMPLETED', target_workspace_id: TARGET }));
    const client = { start, get: vi.fn<ForkClient['get']>() };
    renderDialog(client);
    const submit = screen.getByRole('button', { name: 'Fork 시작' });
    await userEvent.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent(/연결하지 못했습니다/);
    await userEvent.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent(/3초/);
    const name = screen.getByRole('textbox', { name: '새 Workspace 이름' });
    await userEvent.clear(name);
    await userEvent.type(name, '다른 이름');
    await userEvent.click(submit);
    const keys = start.mock.calls.map((c) => c[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(await screen.findByText('Fork 완료')).toBeInTheDocument();
  });

  it('shows a failure alert with a retry that starts a new fork', async () => {
    const start = vi
      .fn<ForkClient['start']>()
      .mockResolvedValueOnce(fork({ status: 'FAILED', error_code: 'fork_failed' }))
      .mockResolvedValue(fork({ status: 'COMPLETED', target_workspace_id: TARGET }));
    renderDialog({ start, get: vi.fn<ForkClient['get']>() });
    await userEvent.click(screen.getByRole('button', { name: 'Fork 시작' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Fork 실패/);
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1]?.[1]).not.toBe(start.mock.calls[0]?.[1]);
    expect(await screen.findByText('Fork 완료')).toBeInTheDocument();
  });

  it('reports a cancellation because the link became unusable, without retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = fakeClient(
      async () => fork({ status: 'COPYING', progress: 90 }),
      async () => fork({ status: 'CANCELLED', error_code: 'share_unavailable' }),
    );
    renderDialog(client);
    await userEvent.click(screen.getByRole('button', { name: 'Fork 시작' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(await screen.findByText('Fork 취소됨')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/링크를 사용할 수 없/);
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
  });

  it('shows request refusals such as Fork OFF in an alert', async () => {
    const client = fakeClient(
      async () => {
        throw new ForkRequestError('notAllowed', 403);
      },
      async () => fork(),
    );
    renderDialog(client);
    await userEvent.click(screen.getByRole('button', { name: 'Fork 시작' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Fork를 허용하지 않습니다/);
  });

  it('returns focus to the entry on Escape and Cancel, or to the fallback when it is gone', async () => {
    const client = fakeClient(
      async () => fork(),
      async () => fork(),
    );
    function Host({ entry }: { entry: boolean }) {
      const [open, setOpen] = useState(true);
      return (
        <>
          {entry ? (
            <a id="entry" href="#fork" onClick={() => setOpen(true)}>
              Fork
            </a>
          ) : null}
          <h1 id="fallback" tabIndex={-1}>
            공유 알고리즘
          </h1>
          <ForkWorkspaceDialog
            shareId={SHARE}
            screenId="WS-FORK-01"
            open={open}
            onOpenChange={setOpen}
            sourceName="공유 알고리즘"
            returnFocusTo={() =>
              document.getElementById('entry') ?? document.getElementById('fallback')
            }
            client={client}
          />
        </>
      );
    }
    const first = render(<Host entry />);
    expect(screen.getByRole('textbox', { name: '새 Workspace 이름' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.getElementById('entry')).toHaveFocus();

    await userEvent.click(screen.getByRole('link', { name: 'Fork' }));
    await userEvent.click(await screen.findByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.getElementById('entry')).toHaveFocus();
    first.unmount();

    render(<Host entry={false} />);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: '공유 알고리즘' })).toHaveFocus();
  });
});
