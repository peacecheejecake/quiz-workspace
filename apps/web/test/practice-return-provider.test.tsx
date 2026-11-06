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
import { publishVerifiedUser } from '../src/lib/auth/verified-user-events';

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
type AuthCallback = (event: string, session?: { user: { id: string } } | null) => void;
const auth = vi.hoisted(() => ({ callback: (() => undefined) as AuthCallback }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: vi.fn() }),
}));
vi.mock('@/lib/supabase/client', () => ({
  getSupabaseBrowserClient: () => ({
    auth: {
      onAuthStateChange: (callback: AuthCallback) => {
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
  identityNavigate.mockReset();
  vi.useRealTimers();
  publishVerifiedUser(null);
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
it('UX11-RETURN-AC04 keeps the page and target through an identity outage and restores buffered activity', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: ownerId }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  setup();
  await act(async () => {
    fireEvent.focus(window);
    await Promise.resolve();
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(document.body).not.toHaveAttribute('data-identity-pending');
  fireEvent.click(screen.getByText('activity'));
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
  expect(document.body).not.toHaveAttribute('data-identity-pending');
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

function deferredIdentity() {
  const replies: ((response: Response) => void)[] = [];
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((done) => {
        replies.push(done);
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  return {
    fetcher,
    reply: (id: string | null) =>
      act(async () => replies.shift()?.(new Response(JSON.stringify({ id }), { status: 200 }))),
  };
}
const returnButton = () => screen.getByRole('button', { name: '보던 문제로 돌아가기' });

it.each(['focus', 'pageshow'])(
  'UX11-RETURN-AC04 a same-user %s never hides the page or unmounts the control',
  async (trigger) => {
    const identity = deferredIdentity();
    setup();
    fireEvent.click(screen.getByText('activity'));
    const button = returnButton();
    fireEvent(window, new Event(trigger));
    expect(identity.fetcher).toHaveBeenCalledTimes(1);
    expect(document.body).not.toHaveAttribute('data-identity-pending');
    expect(returnButton()).toBe(button);
    expect(screen.queryByRole('status')).toBeNull();
    await identity.reply(ownerId);
    expect(document.body).not.toHaveAttribute('data-identity-pending');
    expect(returnButton()).toBe(button);
    expect(screen.queryByRole('status')).toBeNull();
  },
);

it('UX11-RETURN-AC04 the return click keeps the control mounted and only marks it busy', async () => {
  lookup.mockResolvedValue({ ok: true, data: { id: questionId } });
  const identity = deferredIdentity();
  setup();
  fireEvent.click(screen.getByText('activity'));
  const button = returnButton();
  fireEvent.click(button);
  expect(document.body).not.toHaveAttribute('data-identity-pending');
  expect(returnButton()).toBe(button);
  expect(button).toBeDisabled();
  await identity.reply(ownerId);
  await waitFor(() =>
    expect(nav.push).toHaveBeenCalledWith(`/workspaces/${workspaceId}?question=${questionId}`),
  );
  expect(document.body).not.toHaveAttribute('data-identity-pending');
});

it('UX11-RETURN-AC04 a return click during an outage reports a temporary failure and keeps the target', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  setup();
  fireEvent.click(screen.getByText('activity'));
  fireEvent.click(returnButton());
  expect(await screen.findByText(/다시 시도/)).toBeInTheDocument();
  expect(returnButton()).toBeEnabled();
  expect(document.body).not.toHaveAttribute('data-identity-pending');
  expect(nav.push).not.toHaveBeenCalled();
});

it('UX11-RETURN-AC04 buffers activity during a silent check and applies it for the same owner', async () => {
  const identity = deferredIdentity();
  setup();
  fireEvent.focus(window);
  fireEvent.click(screen.getByText('activity'));
  expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기' })).toBeNull();
  await identity.reply(ownerId);
  expect(returnButton()).toBeVisible();
});

it('UX11-RETURN-AC04 a route change during a silent check does not hide the page', async () => {
  const identity = deferredIdentity();
  const view = setup();
  fireEvent.focus(window);
  nav.path = `/workspaces/${workspaceId}`;
  view.rerender(
    <PracticeReturnProvider userId={ownerId}>
      <Activity />
    </PracticeReturnProvider>,
  );
  await waitFor(() => expect(identity.fetcher).toHaveBeenCalledTimes(2));
  expect(document.body).not.toHaveAttribute('data-identity-pending');
  await identity.reply(ownerId);
  await identity.reply(ownerId);
  expect(document.body).not.toHaveAttribute('data-identity-pending');
});

it('UX11-RETURN-AC04 hides the page as soon as a silent check confirms another account', async () => {
  const other = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const identity = deferredIdentity();
  setup();
  fireEvent.click(screen.getByText('activity'));
  fireEvent.focus(window);
  expect(document.body).not.toHaveAttribute('data-identity-pending');
  await identity.reply(other);
  expect(document.body).toHaveAttribute('data-identity-pending');
  expect(identityNavigate).toHaveBeenCalledWith(other);
  expect(screen.queryByRole('button', { name: '보던 문제로 돌아가기' })).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

it('UX11-RETURN-AC04 hides the page as soon as a silent check confirms sign-out', async () => {
  const identity = deferredIdentity();
  setup();
  fireEvent.focus(window);
  await identity.reply(null);
  expect(document.body).toHaveAttribute('data-identity-pending');
  expect(identityNavigate).toHaveBeenCalledWith(null);
});

it('UX11-RETURN-AC04 a same-user SIGNED_IN from a tab return stays silent', async () => {
  const identity = deferredIdentity();
  setup();
  act(() => auth.callback('SIGNED_IN', { user: { id: ownerId } }));
  expect(identity.fetcher).toHaveBeenCalledTimes(1);
  expect(document.body).not.toHaveAttribute('data-identity-pending');
  await identity.reply(ownerId);
  expect(document.body).not.toHaveAttribute('data-identity-pending');
});

it.each([
  ['SIGNED_OUT', null],
  ['SIGNED_IN', { user: { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' } }],
  ['SIGNED_IN', null],
])(
  'UX11-RETURN-AC04 %s without the same user hides the page until the server confirms',
  async (event, session) => {
    const identity = deferredIdentity();
    setup();
    act(() => auth.callback(event, session));
    expect(document.body).toHaveAttribute('data-identity-pending');
    await identity.reply(ownerId);
    expect(document.body).not.toHaveAttribute('data-identity-pending');
  },
);

it('UX11-RETURN-AC04 a later focus cannot downgrade an unresolved auth-event check', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  setup();
  act(() => auth.callback('SIGNED_OUT'));
  await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
  fireEvent.focus(window);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  await act(async () => Promise.resolve());
  expect(document.body).toHaveAttribute('data-identity-pending');
  fetcher.mockImplementation(
    async () => new Response(JSON.stringify({ id: ownerId }), { status: 200 }),
  );
  fireEvent.focus(window);
  await waitFor(() => expect(document.body).not.toHaveAttribute('data-identity-pending'));
  expect(screen.queryByRole('status')).toBeNull();
});

it('UX11-RETURN-AC04 shows a small notice only after ten seconds of failed silent checks', async () => {
  vi.useFakeTimers();
  nav.search = `practice=${questionId}`;
  const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  setup();
  await act(async () => {
    fireEvent.focus(window);
    await vi.advanceTimersByTimeAsync(9_900);
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(screen.getByRole('status')).toHaveTextContent('연결');
  expect(screen.getByRole('status')).not.toHaveTextContent('계정을 확인하고 있습니다');
  expect(document.body).not.toHaveAttribute('data-identity-pending');
  fetcher.mockImplementation(
    async () => new Response(JSON.stringify({ id: ownerId }), { status: 200 }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(screen.queryByRole('status')).toBeNull();
});

it('UX11-RETURN-AC04 shows the notice over an open modal during an outage', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  const { ModalDialog } = await import('@quiz/ui');
  render(
    <PracticeReturnProvider userId={ownerId}>
      <ModalDialog open onOpenChange={() => undefined} title="Modal">
        <p>content</p>
      </ModalDialog>
    </PracticeReturnProvider>,
  );
  await act(async () => {
    fireEvent.focus(window);
    await vi.advanceTimersByTimeAsync(10_100);
  });
  expect(screen.getByText(/연결/)).toBeInTheDocument();
});

it('UX11-RETURN-AC04 keeps a visible notice in the accessibility tree when a modal opens', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  const { ModalDialog } = await import('@quiz/ui');
  const tree = (open: boolean) => (
    <PracticeReturnProvider userId={ownerId}>
      <ModalDialog open={open} onOpenChange={() => undefined} title="Modal">
        <p>content</p>
      </ModalDialog>
    </PracticeReturnProvider>
  );
  const view = render(tree(false));
  await act(async () => {
    fireEvent.focus(window);
    await vi.advanceTimersByTimeAsync(10_100);
  });
  expect(screen.getByRole('status')).toHaveTextContent('연결');
  await act(async () => {
    view.rerender(tree(true));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole('dialog', { name: 'Modal' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('연결');
  expect(screen.getByRole('status').closest('[aria-hidden="true"]')).toBeNull();
});

it('UX11-RETURN-AC04 an auth-event outage keeps the page hidden and explains why at once', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  setup();
  act(() => auth.callback('SIGNED_OUT'));
  expect(screen.queryByRole('status')).toBeNull();
  expect(await screen.findByRole('status')).toHaveTextContent('연결');
  expect(document.body).toHaveAttribute('data-identity-pending');
});
