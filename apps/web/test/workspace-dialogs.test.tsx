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

const nav = { pathname: '/workspaces', search: '' };
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const createWorkspaceAction =
  vi.fn<(prev: WorkspaceFormState, data: FormData) => Promise<WorkspaceFormState>>();
const renameWorkspaceAction =
  vi.fn<(prev: WorkspaceFormState, data: FormData) => Promise<WorkspaceFormState>>();
vi.mock('../src/lib/workspaces/actions', () => ({
  createWorkspaceAction: (prev: WorkspaceFormState, data: FormData) =>
    createWorkspaceAction(prev, data),
  renameWorkspaceAction: (prev: WorkspaceFormState, data: FormData) =>
    renameWorkspaceAction(prev, data),
  archiveWorkspaceAction: vi.fn(),
  restoreWorkspaceAction: vi.fn(),
  deleteWorkspaceAction: vi.fn(),
}));

const { CreateWorkspaceButton, CreateWorkspaceProvider } =
  await import('../src/components/workspaces/create-workspace');
const { AppFrame, drawerFor } = await import('../src/components/app-shell/app-frame');
const { WorkspaceListItem } = await import('../src/components/workspaces/workspace-list-item');
const { WorkspaceTabs } = await import('../src/components/workspaces/workspace-tabs');

const WS_ID = '3f2b6f0e-8a4c-4d7e-9a51-1c2d3e4f5a6b';

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
  renameWorkspaceAction.mockReset();
  nav.pathname = '/workspaces';
  nav.search = '';
});

describe('WS-01 home header (UX1)', () => {
  const workspace = {
    id: WS_ID,
    name: '물리 1',
    role: 'owner',
    status: 'active',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  } as unknown as Parameters<typeof WorkspaceTabs>[0]['active'][number];

  function renderTabs(active: (typeof workspace)[], archived: (typeof workspace)[] = []) {
    return render(
      <ToastProvider>
        <CreateWorkspaceProvider>
          <WorkspaceTabs active={active} archived={archived} />
        </CreateWorkspaceProvider>
      </ToastProvider>,
    );
  }

  it('WS-01-AC01 shows exactly one create CTA (the empty state) when there are no workspaces', () => {
    renderTabs([]);
    expect(screen.getAllByRole('button', { name: 'Workspace 만들기' })).toHaveLength(1);
    expect(screen.queryByText(/자료와 문제를 Workspace 단위로/)).toBeNull();
  });

  it('keeps the header CTA when workspaces exist and on the archived tab', () => {
    const { unmount } = renderTabs([workspace]);
    expect(screen.getAllByRole('button', { name: 'Workspace 만들기' })).toHaveLength(1);
    unmount();
    nav.search = 'status=archived';
    renderTabs([], [{ ...workspace, status: 'archived' }]);
    expect(screen.getAllByRole('button', { name: 'Workspace 만들기' })).toHaveLength(1);
  });

  it('shows tab counts as plain text inside the tab name, without a badge', () => {
    renderTabs([workspace], []);
    const active = screen.getByRole('tab', { name: '활성 1' });
    expect(active.querySelector('.qz-badge')).toBeNull();
    expect(screen.getByRole('tab', { name: '보관됨 0' })).toBeInTheDocument();
  });
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

describe('responses for an earlier dialog session (dialog reopened before they arrived)', () => {
  async function openCreate(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Workspace 만들기' }));
    return screen.findByRole('dialog', { name: 'Workspace 만들기' });
  }

  it.each([
    [
      'success',
      { status: 'done', attempt: 1, workspace: { id: WS_ID, name: '첫 번째' } },
      '‘첫 번째’ Workspace를 만들었습니다.',
    ],
    [
      'failure',
      { status: 'error', failure: 'unavailable', attempt: 1, error: '서버 오류' },
      '서버 오류',
    ],
  ] as const)(
    'create: an old %s toasts but leaves the new session alone',
    async (_, result, toast) => {
      const user = userEvent.setup();
      const first = deferred<WorkspaceFormState>();
      createWorkspaceAction.mockReturnValueOnce(first.promise);
      render(<Home />);

      let dialog = await openCreate(user);
      await user.type(within(dialog).getByRole('textbox', { name: /이름/ }), '첫 번째');
      await user.click(within(dialog).getByRole('button', { name: '만들기' }));
      await waitFor(() => expect(createWorkspaceAction).toHaveBeenCalledTimes(1));
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      dialog = await openCreate(user);
      const input = within(dialog).getByRole('textbox', { name: /이름/ });
      await user.type(input, '두 번째');
      // The new session is not busy with the old request.
      expect(within(dialog).getByRole('button', { name: '만들기' })).toBeEnabled();

      await act(async () => {
        first.resolve(result);
      });
      expect(await screen.findByText(toast, { selector: '.qz-toast__title' })).toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'Workspace 만들기' })).toBe(dialog);
      expect(input).toHaveValue('두 번째');
      expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    },
  );

  it.each([
    [
      'success',
      { status: 'done', attempt: 1, workspace: { id: WS_ID, name: '첫 이름' } },
      '이름을 ‘첫 이름’(으)로 바꿨습니다.',
    ],
    [
      'failure',
      { status: 'error', failure: 'archived', attempt: 1, error: '보관됨 오류' },
      '보관됨 오류',
    ],
  ] as const)(
    'rename: an old %s toasts but leaves the new session alone',
    async (_, result, toast) => {
      const user = userEvent.setup();
      const first = deferred<WorkspaceFormState>();
      renameWorkspaceAction.mockReturnValueOnce(first.promise);
      render(
        <ToastProvider>
          <ul>
            <WorkspaceListItem
              workspace={{
                id: WS_ID,
                name: '운영체제',
                role: 'owner',
                status: 'active',
                archived_at: null,
                created_at: '2026-10-17T00:00:00Z',
                updated_at: '2026-10-17T00:00:00Z',
              }}
            />
          </ul>
        </ToastProvider>,
      );
      async function openRename() {
        await user.click(screen.getByRole('button', { name: /더보기/ }));
        await user.click(await screen.findByRole('menuitem', { name: '이름 변경' }));
        return screen.findByRole('dialog', { name: 'Workspace 이름 변경' });
      }

      let dialog = await openRename();
      let input = within(dialog).getByRole('textbox', { name: /이름/ });
      await user.clear(input);
      await user.type(input, '첫 이름');
      await user.click(within(dialog).getByRole('button', { name: '저장' }));
      await waitFor(() => expect(renameWorkspaceAction).toHaveBeenCalledTimes(1));
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      dialog = await openRename();
      input = within(dialog).getByRole('textbox', { name: /이름/ });
      await user.clear(input);
      await user.type(input, '둘째 이름');
      expect(within(dialog).getByRole('button', { name: '저장' })).toBeEnabled();

      await act(async () => {
        first.resolve(result);
      });
      expect(await screen.findByText(toast, { selector: '.qz-toast__title' })).toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'Workspace 이름 변경' })).toBe(dialog);
      expect(input).toHaveValue('둘째 이름');
      expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    },
  );
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
