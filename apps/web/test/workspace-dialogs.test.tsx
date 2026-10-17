// @vitest-environment jsdom
// M3.1b review fixes: the create dialog's result handling survives dismissal while pending (toast
// + fresh Idempotency-Key afterwards), focus returns to the CTA that opened it, and the mobile
// drawer never reopens when the user navigates back.
import './dom-setup';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@quiz/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFormState } from '../src/lib/workspaces/actions';

const nav = { pathname: '/workspaces' };
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const createWorkspaceAction =
  vi.fn<(prev: WorkspaceFormState, data: FormData) => Promise<WorkspaceFormState>>();
vi.mock('../src/lib/workspaces/actions', () => ({
  createWorkspaceAction: (prev: WorkspaceFormState, data: FormData) =>
    createWorkspaceAction(prev, data),
}));

const { CreateWorkspaceButton, CreateWorkspaceProvider } =
  await import('../src/components/workspaces/create-workspace');
const { AppFrame, drawerFor } = await import('../src/components/app-shell/app-frame');

function Home() {
  return (
    <ToastProvider>
      <CreateWorkspaceProvider>
        <CreateWorkspaceButton />
      </CreateWorkspaceProvider>
    </ToastProvider>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  createWorkspaceAction.mockReset();
  nav.pathname = '/workspaces';
});

describe('create workspace dialog', () => {
  it('delivers the result after the dialog was dismissed mid-request and then mints a new key', async () => {
    const user = userEvent.setup();
    const first = deferred<WorkspaceFormState>();
    createWorkspaceAction.mockReturnValueOnce(first.promise);
    render(<Home />);

    await user.click(screen.getByRole('button', { name: 'Workspace 만들기' }));
    let dialog = await screen.findByRole('dialog', { name: 'Workspace 만들기' });
    await user.type(within(dialog).getByRole('textbox', { name: /이름/ }), '운영체제');
    await user.click(within(dialog).getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(createWorkspaceAction).toHaveBeenCalledTimes(1));
    const firstKey = createWorkspaceAction.mock.calls[0]?.[1].get('idempotencyKey');
    expect(firstKey).toBeTruthy();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await act(async () => {
      first.resolve({
        status: 'done',
        attempt: 1,
        workspace: { id: '3f2b6f0e-8a4c-4d7e-9a51-1c2d3e4f5a6b', name: '운영체제' },
      });
    });
    expect(await screen.findByText('‘운영체제’ Workspace를 만들었습니다.')).toBeInTheDocument();

    // An intentional second create with the same name is a new creation, not a replay.
    createWorkspaceAction.mockResolvedValueOnce({ status: 'error', attempt: 2, error: '실패' });
    await user.click(screen.getByRole('button', { name: 'Workspace 만들기' }));
    dialog = await screen.findByRole('dialog', { name: 'Workspace 만들기' });
    await user.type(within(dialog).getByRole('textbox', { name: /이름/ }), '운영체제');
    await user.click(within(dialog).getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(createWorkspaceAction).toHaveBeenCalledTimes(2));
    expect(createWorkspaceAction.mock.calls[1]?.[1].get('idempotencyKey')).not.toBe(firstKey);
  });

  it('reuses the key when retrying the same name after a failure', async () => {
    const user = userEvent.setup();
    createWorkspaceAction.mockResolvedValue({
      status: 'error',
      failure: 'unavailable',
      attempt: 1,
      error: '일시적인 오류',
    });
    render(<Home />);
    await user.click(screen.getByRole('button', { name: 'Workspace 만들기' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /이름/ }), '네트워크');
    await user.click(within(dialog).getByRole('button', { name: '만들기' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('일시적인 오류');
    await user.click(within(dialog).getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(createWorkspaceAction).toHaveBeenCalledTimes(2));
    const [a, b] = createWorkspaceAction.mock.calls.map(([, data]) => data.get('idempotencyKey'));
    expect(a).toBeTruthy();
    expect(b).toBe(a);
  });

  it('reports a failure as a toast when the dialog was dismissed while pending', async () => {
    const user = userEvent.setup();
    const pending = deferred<WorkspaceFormState>();
    createWorkspaceAction.mockReturnValueOnce(pending.promise);
    render(<Home />);
    await user.click(screen.getByRole('button', { name: 'Workspace 만들기' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /이름/ }), 'x');
    await user.click(within(dialog).getByRole('button', { name: '만들기' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await act(async () => {
      pending.resolve({ status: 'error', failure: 'unavailable', attempt: 1, error: '서버 오류' });
    });
    expect(await screen.findByText('서버 오류')).toBeInTheDocument();
  });

  it('returns focus to the CTA after a keyboard open and Escape', async () => {
    const user = userEvent.setup();
    render(<Home />);
    const cta = screen.getByRole('button', { name: 'Workspace 만들기' });
    cta.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: /이름/ })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(cta).toHaveFocus();

    await user.keyboard('{Enter}');
    const again = await screen.findByRole('dialog');
    await user.click(within(again).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(cta).toHaveFocus();
  });
});

describe('AppFrame mobile drawer', () => {
  it('resets to closed on any pathname change', () => {
    const open = { open: true, pathname: '/a' };
    expect(drawerFor(open, '/a')).toBe(open);
    expect(drawerFor(open, '/b')).toEqual({ open: false, pathname: '/b' });
  });

  it('does not reopen when navigating back to the page it was opened on', async () => {
    const user = userEvent.setup();
    nav.pathname = '/workspaces/a/documents';
    const frame = () => (
      <AppFrame header={<span>Quiz</span>} sidebar={<a href="#search">검색</a>}>
        본문
      </AppFrame>
    );
    const { rerender } = render(frame());
    await user.click(screen.getByRole('button', { name: '메뉴 열기' }));
    expect(await screen.findByRole('dialog', { name: '주 메뉴' })).toBeInTheDocument();

    nav.pathname = '/workspaces/a/search'; // link in the drawer
    rerender(frame());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    nav.pathname = '/workspaces/a/documents'; // browser Back
    rerender(frame());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
