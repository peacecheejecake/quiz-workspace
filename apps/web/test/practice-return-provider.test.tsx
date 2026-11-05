// @vitest-environment jsdom
import './dom-setup';
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  PracticeReturnIdentity,
  PracticeReturnProvider,
  usePracticeReturn,
} from '../src/components/practice-return/practice-return-provider';

const nav = vi.hoisted(() => ({
  path: '/settings/security',
  search: '',
  push: vi.fn(),
  replace: vi.fn(),
}));
const lookup = vi.hoisted(() => vi.fn());
const identityNavigate = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/auth/identity-navigation', () => ({ navigateForIdentity: identityNavigate }));
const ownerId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const runApi = vi.hoisted(() => ({ getRun: vi.fn(), getItem: vi.fn() }));
const auth = vi.hoisted(() => ({ callback: (_event: string): void => undefined }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: vi.fn() }),
}));
vi.mock('@/lib/supabase/client', () => ({
  getSupabaseBrowserClient: () => ({
    auth: {
      onAuthStateChange: (callback: (event: string) => void) => {
        auth.callback = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    },
  }),
}));
vi.mock('@/lib/questions/practice-run-client', () => ({ createPracticeRunApi: () => runApi }));
vi.mock('@/lib/questions/practice-actions', () => ({ lookupOverviewQuestionAction: lookup }));
const workspaceId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const questionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
function Activity() {
  const { recordActivity } = usePracticeReturn();
  return (
    <button onClick={() => recordActivity({ kind: 'question', workspaceId, questionId })}>
      activity
    </button>
  );
}
function setup() {
  return render(
    <PracticeReturnProvider userId={ownerId}>
      {nav.path.startsWith('/settings') ? <PracticeReturnIdentity userId={ownerId} /> : null}
      <Activity />
    </PracticeReturnProvider>,
  );
}
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ id: ownerId }), { status: 200 })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  nav.path = '/settings/security';
  nav.search = '';
  nav.push.mockReset();
  nav.replace.mockReset();
  lookup.mockReset();
  runApi.getRun.mockReset();
  runApi.getItem.mockReset();
});
it('UX11-RETURN-AC02 validates the last target before navigating', async () => {
  lookup.mockResolvedValue({ ok: true, data: { id: questionId } });
  setup();
  fireEvent.click(screen.getByText('activity'));
  fireEvent.click(screen.getByRole('button', { name: '보던 문제로 돌아가기' }));
  await waitFor(() =>
    expect(nav.push).toHaveBeenCalledWith(`/workspaces/${workspaceId}?question=${questionId}`),
  );
});
it('UX11-RETURN-AC03 dismisses the control until another activity', () => {
  setup();
  fireEvent.click(screen.getByText('activity'));
  fireEvent.click(screen.getByRole('button', { name: '복귀 버튼 닫기' }));
  expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기' })).toBeNull();
  fireEvent.click(screen.getByText('activity'));
  expect(screen.getByRole('button', { name: '보던 문제로 돌아가기' })).toBeTruthy();
});
it('UX11-RETURN-AC04 removes an unavailable target and reports it', async () => {
  lookup.mockResolvedValue({ ok: true, data: null });
  setup();
  fireEvent.click(screen.getByText('activity'));
  fireEvent.click(screen.getByRole('button', { name: '보던 문제로 돌아가기' }));
  expect(await screen.findByText(/더 이상 열 수 없습니다/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기' })).toBeNull();
  expect(nav.push).not.toHaveBeenCalled();
});
it('UX11-RETURN-AC02 hides while a practice route is open', () => {
  nav.search = `question=${questionId}`;
  setup();
  fireEvent.click(screen.getByText('activity'));
  expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기' })).toBeNull();
});

it('UX11-RETURN-AC05 hides the control under a modal and restores it after closing', async () => {
  const { ModalDialog } = await import('@quiz/ui');
  function WithModal() {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <Activity />
        <button onClick={() => setOpen(true)}>open modal</button>
        <ModalDialog open={open} onOpenChange={setOpen} title="Modal">
          <p>content</p>
        </ModalDialog>
      </>
    );
  }
  render(
    <PracticeReturnProvider userId={ownerId}>
      <WithModal />
    </PracticeReturnProvider>,
  );
  fireEvent.click(screen.getByText('activity'));
  expect(screen.getByRole('button', { name: '보던 문제로 돌아가기' })).toBeTruthy();
  fireEvent.click(screen.getByText('open modal'));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기' })).toBeNull(),
  );
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '보던 문제로 돌아가기' })).toBeTruthy(),
  );
});

it('UX11-RETURN-AC04 clears on logout and ignores an in-flight validation', async () => {
  let resolve!: (value: unknown) => void;
  lookup.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  setup();
  fireEvent.click(screen.getByText('activity'));
  fireEvent.click(screen.getByRole('button', { name: '보던 문제로 돌아가기' }));
  await waitFor(() => expect(lookup).toHaveBeenCalled());
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ id: null }), { status: 200 })),
  );
  act(() => auth.callback('SIGNED_OUT'));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기' })).toBeNull(),
  );
  await act(async () => resolve({ ok: true, data: { id: questionId } }));
  expect(nav.push).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기' })).toBeNull();
});

it('UX11-RETURN-AC04 clears the target when a different verified account arrives', () => {
  function SwitchAccount() {
    const { setVerifiedUser } = usePracticeReturn();
    return <button onClick={() => setVerifiedUser('another-user')}>switch account</button>;
  }
  render(
    <PracticeReturnProvider userId={ownerId}>
      <Activity />
      <SwitchAccount />
    </PracticeReturnProvider>,
  );
  fireEvent.click(screen.getByText('activity'));
  fireEvent.click(screen.getByText('switch account'));
  expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기' })).toBeNull();
});
it('UX11-RETURN-AC04 keeps the target when a transient validation fails', async () => {
  lookup.mockResolvedValue({ ok: false, kind: 'unavailable' });
  setup();
  fireEvent.click(screen.getByText('activity'));
  fireEvent.click(screen.getByRole('button', { name: '보던 문제로 돌아가기' }));
  expect(await screen.findByText(/다시 시도/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '보던 문제로 돌아가기' })).toBeTruthy();
});

it('UX11-RETURN-AC04 does not show the return control on a public sharing route', () => {
  nav.path = '/share/example';
  setup();
  fireEvent.click(screen.getByText('activity'));
  expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기' })).toBeNull();
});

it('UX11-RETURN-AC02 revalidates and returns to the same run position', async () => {
  const runId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  runApi.getRun.mockResolvedValue({ ok: true, data: {} });
  runApi.getItem.mockResolvedValue({ ok: true, data: { available: true } });
  function RunActivity() {
    const { recordActivity } = usePracticeReturn();
    return (
      <button onClick={() => recordActivity({ kind: 'run', workspaceId, runId, position: 12 })}>
        run activity
      </button>
    );
  }
  render(
    <PracticeReturnProvider userId={ownerId}>
      <PracticeReturnIdentity userId={ownerId} />
      <RunActivity />
    </PracticeReturnProvider>,
  );
  fireEvent.click(screen.getByText('run activity'));
  fireEvent.click(screen.getByRole('button', { name: '보던 문제로 돌아가기' }));
  await waitFor(() =>
    expect(nav.push).toHaveBeenCalledWith(`/workspaces/${workspaceId}?practice=${runId}&i=12`),
  );
  expect(runApi.getItem).toHaveBeenCalledWith(runId, 12);
});

it('UX11-RETURN-AC04 fences a changed server identity on focus without an auth event', async () => {
  const other = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ id: other }), { status: 200 })),
  );
  setup();
  fireEvent.click(screen.getByText('activity'));
  fireEvent.focus(window);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기' })).toBeNull(),
  );
  expect(nav.push).not.toHaveBeenCalled();
});
it('UX11-RETURN-AC04 keeps target suspended through identity outage and restores it for same owner', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: ownerId }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  setup();
  fireEvent.click(screen.getByText('activity'));
  fireEvent.focus(window);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기' })).toBeNull();
  fireEvent.focus(window);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '보던 문제로 돌아가기' })).toBeTruthy(),
  );
});

it('UX11-RETURN-AC04 ignores an older shell identity after a newer verified response', async () => {
  const other = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const { PracticeReturnIdentity } =
    await import('../src/components/practice-return/practice-return-provider');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ id: other }), { status: 200 })),
  );
  const view = render(
    <PracticeReturnProvider userId={ownerId}>
      <PracticeReturnIdentity userId={ownerId} />
      <Activity />
    </PracticeReturnProvider>,
  );
  fireEvent.click(screen.getByText('activity'));
  fireEvent.focus(window);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기' })).toBeNull(),
  );
  view.rerender(
    <PracticeReturnProvider userId={ownerId}>
      <PracticeReturnIdentity userId={other} />
      <Activity />
    </PracticeReturnProvider>,
  );
  fireEvent.click(screen.getByText('activity'));
  expect(document.body).toHaveAttribute('data-identity-pending');
  expect(identityNavigate).toHaveBeenCalledWith(other);
  view.rerender(
    <PracticeReturnProvider userId={ownerId}>
      <PracticeReturnIdentity userId={ownerId} />
      <Activity />
    </PracticeReturnProvider>,
  );
  expect(document.body).toHaveAttribute('data-identity-pending');
});

it('UX11-RETURN-AC04 discards old-owner activity that arrives while a changed account is confirmed', async () => {
  const other = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  setup();
  fireEvent.focus(window);
  fireEvent.click(screen.getByText('activity'));
  await act(async () => resolve(new Response(JSON.stringify({ id: other }), { status: 200 })));
  fireEvent.click(screen.getByText('activity'));
  expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기' })).toBeNull();
});

it('UX11-RETURN-AC04 keeps the old document suspended even if a new shell arrives before verification', async () => {
  const other = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const { PracticeReturnIdentity } =
    await import('../src/components/practice-return/practice-return-provider');
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  const view = render(
    <PracticeReturnProvider userId={ownerId}>
      <PracticeReturnIdentity userId={ownerId} />
      <Activity />
    </PracticeReturnProvider>,
  );
  fireEvent.focus(window);
  view.rerender(
    <PracticeReturnProvider userId={ownerId}>
      <PracticeReturnIdentity userId={other} />
      <Activity />
    </PracticeReturnProvider>,
  );
  await act(async () => resolve(new Response(JSON.stringify({ id: other }), { status: 200 })));
  fireEvent.click(screen.getByText('activity'));
  expect(document.body).toHaveAttribute('data-identity-pending');
  expect(identityNavigate).toHaveBeenCalledWith(other);
});

it('UX11-RETURN-AC04 keeps the old shell hidden after repeated verification of the new account', async () => {
  const other = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ id: other }), { status: 200 })),
  );
  setup();
  fireEvent.focus(window);
  await waitFor(() => expect(document.body).toHaveAttribute('data-identity-pending'));
  fireEvent.focus(window);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await act(async () => Promise.resolve());
  expect(document.body).toHaveAttribute('data-identity-pending');
});
it('UX11-RETURN-AC04 public pages remain visible after a verified account change', async () => {
  nav.path = '/share/public-id';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ id: null }), { status: 200 })),
  );
  setup();
  fireEvent.focus(window);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  await act(async () => Promise.resolve());
  expect(document.body).not.toHaveAttribute('data-identity-pending');
  expect(screen.getByText('activity')).toBeVisible();
});

it('UX11-RETURN-AC04 automatically recovers a transient identity outage without discarding the target', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: ownerId }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  setup();
  fireEvent.click(screen.getByText('activity'));
  await act(async () => {
    fireEvent.focus(window);
    await Promise.resolve();
  });
  expect(document.body).toHaveAttribute('data-identity-pending');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(document.body).not.toHaveAttribute('data-identity-pending');
  expect(screen.getByRole('button', { name: '보던 문제로 돌아가기' })).toBeVisible();
  vi.useRealTimers();
});

it('UX11-RETURN-AC04 repeated verification never resumes a document during an account transition', async () => {
  const other = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ id: other }), { status: 200 })),
  );
  setup();
  fireEvent.focus(window);
  await waitFor(() => expect(identityNavigate).toHaveBeenCalledWith(other));
  fireEvent.focus(window);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(document.body).toHaveAttribute('data-identity-pending');
});

it('UX11-RETURN-AC05 removes the control while a confirmation dialog or mobile drawer is open', async () => {
  const { AppShell, ConfirmDialog } = await import('@quiz/ui');
  function Overlays() {
    const [confirm, setConfirm] = React.useState(false);
    return (
      <AppShell header="Header" sidebar={<span>Navigation</span>}>
        <Activity />
        <button onClick={() => setConfirm(true)}>confirm</button>
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title="Confirm"
          confirmLabel="Confirm"
          description="Proceed?"
          onConfirm={() => setConfirm(false)}
        />
      </AppShell>
    );
  }
  render(
    <PracticeReturnProvider userId={ownerId}>
      <PracticeReturnIdentity userId={ownerId} />
      <Overlays />
    </PracticeReturnProvider>,
  );
  fireEvent.click(screen.getByText('activity'));
  expect(screen.getByRole('button', { name: '보던 문제로 돌아가기' })).toBeVisible();
  fireEvent.click(screen.getByText('confirm'));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기', hidden: true })).toBeNull(),
  );
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '보던 문제로 돌아가기' })).toBeVisible(),
  );
  fireEvent.click(screen.getByRole('button', { name: '메뉴 열기' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기', hidden: true })).toBeNull(),
  );
});

it('UX11-RETURN-AC04 repeated A to B to A to B transitions each require a fresh document', async () => {
  const other = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  async function transition(from: string, to: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: to }), { status: 200 })),
    );
    const view = render(
      <PracticeReturnProvider userId={from}>
        <PracticeReturnIdentity userId={from} />
        <Activity />
      </PracticeReturnProvider>,
    );
    fireEvent.focus(window);
    await waitFor(() => expect(identityNavigate).toHaveBeenLastCalledWith(to));
    expect(document.body).toHaveAttribute('data-identity-pending');
    view.unmount();
  }
  await transition(ownerId, other);
  await transition(other, ownerId);
  await transition(ownerId, other);
});

it('UX11-RETURN-AC04 shows identity feedback on an open practice URL during an outage', async () => {
  nav.search = `practice=${questionId}`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  setup();
  fireEvent.focus(window);
  expect(await screen.findByRole('status')).toHaveTextContent('계정을 확인하고 있습니다');
  expect(document.body).toHaveAttribute('data-identity-pending');
});
