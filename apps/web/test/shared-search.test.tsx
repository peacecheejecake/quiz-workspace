// @vitest-environment jsdom
// WS-VIEW-01 source search: SEARCH-01-AC06 degraded notice in the shared view, also when the
// keyword fallback finds nothing (M7.4b review fix).
import './dom-setup';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SharedClient, SharedSearchResponse } from '../src/lib/shared/client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { SharedSearch } = await import('../src/components/shared/shared-search');

const SHARE = '0b6a5c0e-1d2f-4a3b-8c4d-5e6f7a8b9c0d';
const NOTICE = /의미 검색을 일시적으로 사용할 수 없어 키워드 결과만/;

function clientAnswering(body: SharedSearchResponse): SharedClient {
  return { search: vi.fn(async () => body) } as unknown as SharedClient;
}

const answer = (degraded: SharedSearchResponse['degraded']): SharedSearchResponse => ({
  mode: 'hybrid',
  query_language: 'en',
  truncated: false,
  warnings: [],
  degraded,
  items: [],
});

async function search(client: SharedClient, query = 'zzz'): Promise<void> {
  const user = userEvent.setup();
  render(<SharedSearch shareId={SHARE} client={client} onUnavailable={vi.fn()} />);
  await user.type(screen.getByRole('searchbox', { name: '검색어' }), `${query}{Enter}`);
  await screen.findByText('검색 결과가 없습니다.');
}

describe('SharedSearch', () => {
  it('SEARCH-01-AC06 shows the degraded notice even when the keyword fallback finds nothing', async () => {
    await search(clientAnswering(answer(['dense_unavailable'])));
    const notice = screen.getAllByRole('status').find((el) => NOTICE.test(el.textContent ?? ''));
    expect(notice).toBeDefined();
    expect(notice).toBeVisible();
  });

  it('shows no notice for a complete answer', async () => {
    await search(clientAnswering(answer([])));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
