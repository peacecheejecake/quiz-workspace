// @vitest-environment jsdom
import './dom-setup';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const auth = vi.hoisted(() => ({
  callback: null as null | ((event: string, session: { user: { id: string } } | null) => void),
}));
vi.mock('../src/lib/supabase/client', () => ({
  getSupabaseBrowserClient: () => ({
    auth: {
      onAuthStateChange: (callback: typeof auth.callback) => {
        auth.callback = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    },
  }),
}));
import { AskPanel } from '../src/components/ask/ask-panel';
import { useAskState } from '../src/components/ask/use-ask-state';

afterEach(() => {
  vi.unstubAllGlobals();
  auth.callback = null;
});

it('bounds missing-session and persistent mismatched-owner checks without remount generations', async () => {
  let owner: string | null = null;
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url === '/api/auth/identity' ? { id: owner } : { available: true, limits: {} },
        ),
        { status: 200 },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const { result } = renderHook(() => useAskState('workspace'));
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  for (let i = 0; i < 4; i += 1)
    await act(async () => {
      await result.current.recovery.verify();
    });
  expect(result.current.identityGeneration).toBe(0);
  owner = 'A';
  await act(async () => {
    await result.current.recovery.verify();
  });
  expect(result.current.state?.available).toBe(true);
  await act(async () => {
    auth.callback?.('SIGNED_IN', { user: { id: 'B' } });
  });
  for (let i = 0; i < 4; i += 1)
    await act(async () => {
      await result.current.recovery.verify();
    });
  expect(result.current.identityGeneration).toBe(1);
  expect(fetcher.mock.calls.length).toBeLessThan(15);
});

it('keeps an open panel bounded under a persistent mismatched event identity', async () => {
  let mounts = 0;
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url === '/api/auth/identity'
            ? { id: 'A' }
            : url.includes('/ask/conversations')
              ? { items: [], next_cursor: null }
              : {
                  available: true,
                  reason: null,
                  limits: { max_question_chars: 1000, max_turns: 20, max_regenerations: 5 },
                },
        ),
        { status: 200 },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  function Panel({ state }: { state: ReturnType<typeof useAskState> }) {
    useEffect(() => {
      mounts += 1;
    }, []);
    return (
      <AskPanel
        open
        onOpenChange={() => undefined}
        container={document.body}
        workspaceId="workspace"
        archived={false}
        askState={state.state}
        client={state.client}
        recovery={state.recovery}
        conversationId={null}
        onNavigate={() => undefined}
        documents={[]}
        intent={null}
      />
    );
  }
  function Owner() {
    const state = useAskState('workspace');
    return <Panel key={state.identityGeneration} state={state} />;
  }
  render(<Owner />);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => {
    auth.callback?.('SIGNED_IN', { user: { id: 'B' } });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(mounts).toBeLessThanOrEqual(2);
  expect(fetcher.mock.calls.length).toBeLessThan(12);
});
