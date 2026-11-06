// @vitest-environment jsdom
// SEARCH-02 the 본문 search page (content-search-page.tsx): what the browser specs cannot pin down
// cheaply — "검색 결과 지우기" clears the query and results only (search-page.md), so the page's
// options stay in its state and in its URL alike and a reload searches the same scope.
import './dom-setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentSearchPage } from '../src/components/search/content-search-page';

// A stable router, as Next's is (the search hook's callbacks depend on it).
const router = vi.hoisted(() => ({ push: () => undefined, replace: () => undefined }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('next/link', () => ({
  useLinkStatus: () => ({ pending: false }),
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../src/lib/supabase/client', () => ({
  getSupabaseBrowserClient: () => ({
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
  }),
}));

const WS = 'ws-1';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('ContentSearchPage', () => {
  it('UX10-AI-AC01 hides the ask action until the server allows it', async () => {
    let resolveState!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url === '/api/auth/identity'
          ? Promise.resolve(new Response(JSON.stringify({ id: 'viewer' })))
          : new Promise<Response>((resolve) => {
              resolveState = resolve;
            }),
      ),
    );
    render(
      <ContentSearchPage
        workspace={{ id: WS, name: '물', archived: false }}
        documents={[]}
        documentsLoadFailed={false}
        searchable={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /AI에게 묻기/ })).toBeNull();
    resolveState(
      new Response(JSON.stringify({ available: false, reason: 'disabled' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: /AI에게 묻기/ })).toBeNull());
  });

  it('shows the search ask action when the server allows it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url === '/api/auth/identity' ? { id: 'viewer' } : { available: true, reason: null },
            ),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
      ),
    );
    render(
      <ContentSearchPage
        workspace={{ id: WS, name: '물', archived: false }}
        documents={[]}
        documentsLoadFailed={false}
        searchable={false}
      />,
    );
    expect(await screen.findByRole('button', { name: /AI에게 묻기/ })).toBeEnabled();
  });

  it('"검색 결과 지우기" removes the query only; the options stay in the URL', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [], warnings: [], degraded: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    // The page also reads whether AI questions are available (`AI에게 묻기`, ASK-01).
    const askState = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', (input: RequestInfo | URL) =>
      String(input).includes('/ask') || String(input).includes('/auth/identity')
        ? askState()
        : fetchSpy(),
    );
    window.history.replaceState(null, '', `/workspaces/${WS}/search?text=water&mode=keyword`);

    render(
      <ContentSearchPage
        workspace={{ id: WS, name: '물', archived: false }}
        documents={[]}
        documentsLoadFailed={false}
        searchable
      />,
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const clear = await screen.findByRole('button', { name: '검색 결과 지우기' });
    await userEvent.setup().click(clear);

    expect(window.location.pathname).toBe(`/workspaces/${WS}/search`);
    expect(window.location.search).toBe('?mode=keyword');
    expect(screen.getByRole('searchbox', { name: '본문 검색어' })).toHaveValue('');
    expect(screen.queryByRole('button', { name: '검색 결과 지우기' })).toBeNull();
  });
});
