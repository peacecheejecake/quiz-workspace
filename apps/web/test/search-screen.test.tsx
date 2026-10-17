// @vitest-environment jsdom
// SEARCH-01 screen behaviour the E2E specs cannot force: 429 with Retry-After and 503 states,
// an older answer never replacing a newer search, mode changes re-running the submitted query,
// the address bar mirroring the search, and the non-modal excerpt panel's refined PDF jump.
import './dom-setup';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SearchApiError,
  type ContentBlock,
  type SearchClient,
  type SearchItem,
  type SearchQuery,
  type SearchResponse,
} from '../src/lib/search/client';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    onClick?: (e: unknown) => void;
  }) => (
    <a href={href} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
}));

const { SearchScreen } = await import('../src/components/search/search-screen');

const WS = '22222222-2222-4222-8222-222222222222';
const DOC = '11111111-1111-4111-8111-111111111111';
const REV = '44444444-4444-4444-8444-444444444444';

const INITIAL: SearchQuery = {
  query: '',
  mode: 'hybrid',
  documentId: null,
  chapterId: null,
  includeQuestionPapers: false,
};

const hit = (overrides: Partial<SearchItem> = {}): SearchItem =>
  ({
    document_id: DOC,
    document_title: 'Water Book',
    document_type: 'book',
    revision_id: REV,
    chunk_id: 'c1',
    chapter_id: null,
    section_id: null,
    breadcrumb: ['Water Book', 'Chapter 2', '2.2 Disinfection'],
    block_id: 'p1',
    block_ids: ['p1', 'p2'],
    context_block_ids: ['p1', 'p2'],
    page: 4,
    bbox: null,
    locations: [],
    text: 'Filters catch particles.\n\nFinally chlorine is added.',
    highlights: [{ start: 0, end: 51 }],
    term_highlights: [{ start: 34, end: 42 }],
    truncated_start: false,
    truncated_end: false,
    language: 'en',
    rank: 1,
    score: 1,
    score_type: 'bm25',
    ...overrides,
  }) as SearchItem;

const response = (items: SearchItem[], warnings: string[] = []): SearchResponse => ({
  query: 'q',
  mode: 'keyword',
  query_language: 'en',
  truncated: false,
  warnings,
  items,
});

function makeClient(
  search: SearchClient['search'],
  chapters: SearchClient['chapters'] = async () => [],
): SearchClient & {
  search: ReturnType<typeof vi.fn>;
} {
  return {
    search: vi.fn(search),
    chapters: vi.fn(chapters),
    block: vi.fn(
      async (_d: string, id: string) =>
        ({
          block_id: id,
          text: id === 'p1' ? 'Filters catch particles.' : 'Finally chlorine is added.',
          page: id === 'p1' ? 4 : 5,
          locations: [],
        }) as unknown as ContentBlock,
    ),
  } as SearchClient & { search: ReturnType<typeof vi.fn> };
}

async function submit(user: ReturnType<typeof userEvent.setup>, query: string) {
  const box = screen.getByRole('searchbox', { name: /검색/ });
  await user.clear(box);
  await user.type(box, `${query}{Enter}`);
}

beforeEach(() => {
  window.history.replaceState(null, '', `/workspaces/${WS}/search`);
  router.push.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SearchScreen', () => {
  it('shows an empty state with guidance from the warnings and mirrors the search in the URL', async () => {
    const user = userEvent.setup();
    const client = makeClient(async () => response([], ['no keyword matches']));
    render(<SearchScreen workspaceId={WS} documents={[]} initial={INITIAL} client={client} />);

    await user.click(screen.getByRole('radio', { name: '키워드' }));
    expect(client.search).not.toHaveBeenCalled(); // nothing submitted yet
    await submit(user, 'zzz');

    expect(await screen.findByRole('heading', { name: '검색 결과가 없습니다' })).toBeVisible();
    expect(screen.getByText(/의미 검색이나 하이브리드/)).toBeVisible();
    expect(screen.queryByRole('list', { name: '검색 결과' })).toBeNull();
    expect(window.location.search).toBe('?q=zzz&mode=keyword');
  });

  it('asks for a query instead of searching blank input', async () => {
    const user = userEvent.setup();
    const client = makeClient(async () => response([]));
    render(<SearchScreen workspaceId={WS} documents={[]} initial={INITIAL} client={client} />);
    await user.click(screen.getByRole('button', { name: '검색' }));
    expect(screen.getByText('검색어를 입력해 주세요.')).toBeVisible();
    expect(client.search).not.toHaveBeenCalled();
  });

  it('re-runs the submitted query when the mode changes and ignores an overtaken answer', async () => {
    const user = userEvent.setup();
    const pending: ((r: SearchResponse) => void)[] = [];
    const client = makeClient(
      (_ws, q) =>
        new Promise<SearchResponse>((resolve) => {
          pending.push(resolve);
          void q;
        }),
    );
    render(<SearchScreen workspaceId={WS} documents={[]} initial={INITIAL} client={client} />);

    await submit(user, 'water');
    await user.click(screen.getByRole('radio', { name: '의미' }));
    expect(client.search).toHaveBeenCalledTimes(2);
    expect(client.search.mock.calls[1]?.[1]).toMatchObject({ query: 'water', mode: 'semantic' });

    // The newer (semantic) answer arrives first; the older one must not replace it.
    act(() => pending[1]?.(response([hit({ document_title: 'Semantic hit' })])));
    act(() => pending[0]?.(response([hit({ document_title: 'Stale keyword hit' })])));
    const list = await screen.findByRole('list', { name: '검색 결과' });
    expect(within(list).getByText('Semantic hit')).toBeVisible();
    expect(within(list).queryByText('Stale keyword hit')).toBeNull();
  });

  it('waits for Retry-After before offering a retry after 429', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      if (calls === 1) throw new SearchApiError('rateLimited', 429, 5);
      return response([hit()]);
    });
    render(<SearchScreen workspaceId={WS} documents={[]} initial={INITIAL} client={client} />);
    await submit(user, 'water');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('5초 후에 다시 시도');
    const retry = within(alert).getByRole('button', { name: '다시 시도' });
    expect(retry).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);
    expect(await screen.findByRole('list', { name: '검색 결과' })).toBeVisible();
  });

  it('explains a 503 and retries on demand', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      if (calls === 1) throw new SearchApiError('unavailable', 503);
      return response([hit()]);
    });
    render(<SearchScreen workspaceId={WS} documents={[]} initial={INITIAL} client={client} />);
    await submit(user, 'water');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('일시적으로 연결할 수 없습니다');
    await user.click(within(alert).getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByRole('list', { name: '검색 결과' })).toBeVisible();
  });

  it('sends an expired session to the login page', async () => {
    const user = userEvent.setup();
    const client = makeClient(async () => {
      throw new SearchApiError('unauthenticated', 401);
    });
    render(<SearchScreen workspaceId={WS} documents={[]} initial={INITIAL} client={client} />);
    await submit(user, 'water');
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    expect(router.push.mock.calls[0]?.[0]).toMatch(/^\/login\?next=/);
  });

  it('runs a search from the address bar on arrival', async () => {
    const client = makeClient(async () => response([hit()]));
    render(
      <SearchScreen
        workspaceId={WS}
        documents={[]}
        initial={{ ...INITIAL, query: 'chlorine', mode: 'keyword' }}
        client={client}
      />,
    );
    expect(await screen.findByRole('list', { name: '검색 결과' })).toBeVisible();
    expect(client.search.mock.calls[0]?.[1]).toMatchObject({ query: 'chlorine', mode: 'keyword' });
  });

  it('opens the excerpt in a non-modal panel whose PDF link targets the matching block', async () => {
    const user = userEvent.setup();
    const client = makeClient(async () => response([hit()]));
    render(<SearchScreen workspaceId={WS} documents={[]} initial={INITIAL} client={client} />);
    await submit(user, 'chlorine');
    const list = await screen.findByRole('list', { name: '검색 결과' });
    const item = within(list).getByRole('listitem');
    expect(within(item).getByRole('blockquote')).toHaveTextContent('Finally chlorine is added.');
    expect(item).toHaveTextContent('4쪽');
    await user.click(within(item).getByRole('button', { name: 'Water Book' }));

    const panel = await screen.findByRole('dialog', { name: '원문 발췌' });
    expect(panel).not.toHaveAttribute('aria-modal');
    const link = within(panel).getByRole('link', { name: 'PDF에서 보기' });
    await waitFor(() =>
      expect(link).toHaveAttribute(
        'href',
        `/workspaces/${WS}/documents/${DOC}?page=5&block=p2&revision=${REV}`,
      ),
    );
    expect(panel).toHaveTextContent('5쪽');
    expect(client.block).toHaveBeenCalledWith(DOC, 'p2', REV, expect.anything());

    // The background stays usable: focusing the search box keeps the panel open.
    await user.click(screen.getByRole('searchbox', { name: /검색/ }));
    expect(screen.getByRole('dialog', { name: '원문 발췌' })).toBeVisible();
  });

  it('clears a bookmarked chapter of an older revision before searching, in the URL too', async () => {
    const current = '66666666-6666-4666-8666-666666666666';
    const stale = '77777777-7777-4777-8777-777777777777';
    window.history.replaceState(
      null,
      '',
      `/workspaces/${WS}/search?q=water&document=${DOC}&chapter=${stale}`,
    );
    const client = makeClient(
      async () => response([hit()]),
      async () => [{ id: current, title: 'Chapter 2', children: [] } as never],
    );
    render(
      <SearchScreen
        workspaceId={WS}
        documents={[{ id: DOC, title: 'Water Book', isQuestionPaper: false }]}
        initial={{ ...INITIAL, query: 'water', documentId: DOC, chapterId: stale }}
        client={client}
      />,
    );
    expect(await screen.findByRole('list', { name: '검색 결과' })).toBeVisible();
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(client.search.mock.calls[0]?.[1]).toMatchObject({ documentId: DOC, chapterId: null });
    expect(screen.getByText(/장 필터를 해제했습니다/)).toBeVisible();
    expect(screen.getByRole('combobox', { name: '장' })).toHaveTextContent('전체 장');
    expect(window.location.search).toBe(`?q=water&document=${DOC}`);
  });

  it('keeps a valid bookmarked chapter and searches with it', async () => {
    const chapter = '66666666-6666-4666-8666-666666666666';
    const client = makeClient(
      async () => response([hit()]),
      async () => [{ id: chapter, title: 'Chapter 2', children: [] } as never],
    );
    render(
      <SearchScreen
        workspaceId={WS}
        documents={[{ id: DOC, title: 'Water Book', isQuestionPaper: false }]}
        initial={{ ...INITIAL, query: 'water', documentId: DOC, chapterId: chapter }}
        client={client}
      />,
    );
    expect(await screen.findByRole('list', { name: '검색 결과' })).toBeVisible();
    expect(client.search.mock.calls[0]?.[1]).toMatchObject({ chapterId: chapter });
    expect(client.search).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '장' })).toHaveTextContent('Chapter 2'),
    );
    expect(screen.queryByText(/장 필터를 해제했습니다/)).toBeNull();
  });
});
