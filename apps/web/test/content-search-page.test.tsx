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
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const WS = 'ws-1';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('ContentSearchPage', () => {
  it('"검색 결과 지우기" removes the query only; the options stay in the URL', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [], warnings: [], degraded: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    window.history.replaceState(null, '', `/workspaces/${WS}/search?text=water&mode=keyword`);

    render(
      <ContentSearchPage
        workspace={{ id: WS, name: '물' }}
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
