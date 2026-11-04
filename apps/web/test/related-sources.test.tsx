// @vitest-environment jsdom
// RELSRC-01 관련 본문 (docs/screens/related-sources.md): the relays forward only the gate, the view
// model, and the area's states — collapsed to start with nothing requested until the first expand
// (RELSRC-COLLAPSE), loading / list / none / degraded / error + retry, the excerpt panel on a row,
// and the guest's stored list.
import './dom-setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type * as Bff from '../src/lib/documents/bff';
import type { RelatedClient, RelatedSource } from '../src/lib/related-sources/client';

const relay = vi.hoisted(() => ({ relayToApi: vi.fn() }));
vi.mock('@/lib/documents/bff', async (original) => ({
  ...(await original<typeof Bff>()),
  relayToApi: relay.relayToApi,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const bank = await import('../src/app/api/questions/[questionId]/related-sources/route');
const mock = await import('../src/app/api/mock-exam-questions/[questionId]/related-sources/route');
const { RelatedSources } =
  await import('../src/components/questions/related-sources/related-sources');
const { SharedRelatedSources } =
  await import('../src/components/questions/related-sources/shared-related-sources');
const model = await import('../src/lib/related-sources/model');
const client = await import('../src/lib/related-sources/client');

const WS = '55555555-5555-4555-8555-555555555555';
const ID = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const DOC = '66666666-6666-4666-8666-000000000001';
const REV = '88888888-8888-4888-8888-000000000009';
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;

function source(overrides: Partial<RelatedSource> = {}): RelatedSource {
  return {
    rank: 1,
    document_id: DOC,
    document_title: '물의 순환',
    chapter_id: null,
    chapter_title: '1장',
    block_id: 'b-1',
    block_ids: ['b-1', 'b-2'],
    page_start: 2,
    page_end: 2,
    excerpt: '가나다 원리: 물이 증발한다.',
    highlights: [{ start: 0, end: 3 }],
    from_question_source: true,
    revision_id: REV,
    stale: false,
    score: null,
    ...overrides,
  };
}

function fake(list: () => ReturnType<RelatedClient['list']>): RelatedClient {
  return { list: vi.fn(list), shared: vi.fn() };
}

const target = { kind: 'question', id: ID } as const;
const gate = { practice_session_id: SESSION };

/** Expands the collapsed area (the first expand is what requests the list). */
async function expand() {
  const toggle = screen.getByRole('button', { name: '관련 본문' });
  await userEvent.click(toggle);
  return toggle;
}

const BLOCKS: Record<string, string> = {
  'b-1': '가나다 원리: 물이 증발한다.',
  'b-2': '둘째 블록: 전체 구절의 뒷부분.',
};
const search = {
  block: vi.fn(async (_doc: string, id: string) => ({ text: BLOCKS[id] ?? '' }) as never),
};

describe('RELSRC-01 relays', () => {
  it('forwards only the gate of its kind and refuses a malformed one', async () => {
    relay.relayToApi.mockResolvedValue(Response.json({}));
    await bank.GET(
      new Request(
        `http://web.test/api/questions/${ID}/related-sources?practice_session_id=${SESSION}&x=1`,
      ),
      ctx({ questionId: ID }),
    );
    expect(relay.relayToApi).toHaveBeenLastCalledWith(
      `/questions/${ID}/related-sources?practice_session_id=${SESSION}`,
      { method: 'GET' },
    );
    await mock.GET(
      new Request(`http://web.test/api/mock-exam-questions/${ID}/related-sources?view=manage`),
      ctx({ questionId: ID }),
    );
    expect(relay.relayToApi).toHaveBeenLastCalledWith(
      `/mock-exam-questions/${ID}/related-sources?view=manage`,
      { method: 'GET' },
    );
    relay.relayToApi.mockClear();
    const bad = await bank.GET(
      new Request(`http://web.test/api/questions/${ID}/related-sources?view=manage`),
      ctx({ questionId: ID }),
    );
    expect(bad.status).toBe(400);
    const unknown = await bank.GET(
      new Request('http://web.test/api/questions/nope/related-sources'),
      ctx({ questionId: 'nope' }),
    );
    expect(unknown.status).toBe(404);
    expect(relay.relayToApi).not.toHaveBeenCalled();
  });
});

describe('RELSRC-01 view model and client', () => {
  it('prints pages and locations', () => {
    expect(model.pageRange(2, 2)).toBe('p.2');
    expect(model.pageRange(12, 13)).toBe('p.12–13');
    expect(model.rowLocation(source())).toBe('물의 순환 · 1장 · p.2');
  });

  it('finds the marked words again in the whole passage (code point offsets)', () => {
    const ranges = model.termRangesIn('😀 가나다 끝 가나다', '가나다 원리', [{ start: 0, end: 3 }]);
    expect(ranges).toEqual([
      { start: 2, end: 5 },
      { start: 8, end: 11 },
    ]);
  });

  it('reads the gate into the relay path; a missing shared list is null', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ items: [source()] }));
    const c = client.createRelatedClient(fetchImpl as unknown as typeof fetch);
    const list = await c.list(target, gate);
    expect(list.degraded).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/questions/${ID}/related-sources?practice_session_id=${SESSION}`,
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    const missing = client.createRelatedClient(
      (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    );
    expect(await missing.shared('s', ID)).toBeNull();
  });
});

describe('RELSRC-01 area', () => {
  it('starts collapsed without a request, loads on the first expand, lists rows with marks and the badge, and announces the count', async () => {
    let resolve!: (v: Awaited<ReturnType<RelatedClient['list']>>) => void;
    const c = fake(() => new Promise((r) => (resolve = r)));
    render(
      <RelatedSources
        workspaceId={WS}
        target={target}
        gate={gate}
        client={c}
        searchClient={search}
      />,
    );
    const toggle = screen.getByRole('button', { name: '관련 본문' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(c.list).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
    await expand();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(c.list).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('관련 본문을 찾는 중입니다');
    resolve({
      items: [
        source(),
        source({
          rank: 2,
          block_id: 'b-2',
          from_question_source: false,
          page_start: 4,
          page_end: 5,
        }),
      ],
      degraded: [],
    });
    const list = await screen.findByRole('list', { name: '관련 본문' });
    const rows = within(list).getAllByRole('listitem');
    const [first, second] = rows as [HTMLElement, HTMLElement];
    expect(rows).toHaveLength(2);
    expect(within(first).getByText('문제 출처')).toBeInTheDocument();
    expect(within(second).queryByText('문제 출처')).toBeNull();
    expect(within(second).getByText(/p\.4–5/)).toBeInTheDocument();
    expect(first.querySelector('mark')).toHaveTextContent('가나다');
    expect(within(first).getByRole('link', { name: 'PDF' })).toHaveAttribute(
      'href',
      expect.stringContaining('page=2'),
    );
    expect(screen.getByRole('status')).toHaveTextContent('관련 본문 2개');
  });

  it('collapses and expands by the toggle, reusing the loaded list', async () => {
    const c = fake(async () => ({ items: [source()], degraded: [] }));
    render(
      <RelatedSources
        workspaceId={WS}
        target={target}
        gate={gate}
        client={c}
        searchClient={search}
      />,
    );
    const toggle = await expand();
    await screen.findByRole('list', { name: '관련 본문' });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('list', { name: '관련 본문' })).toBeInTheDocument();
    expect(c.list).toHaveBeenCalledTimes(1);
  });

  it('starts collapsed again for another position (a new target)', async () => {
    const c = fake(async () => ({ items: [source()], degraded: [] }));
    const { rerender } = render(
      <RelatedSources
        workspaceId={WS}
        target={target}
        gate={gate}
        client={c}
        searchClient={search}
      />,
    );
    await expand();
    await screen.findByRole('list', { name: '관련 본문' });
    rerender(
      <RelatedSources
        workspaceId={WS}
        target={{ kind: 'question', id: '33333333-3333-4333-8333-333333333333' }}
        gate={gate}
        client={c}
        searchClient={search}
      />,
    );
    expect(screen.getByRole('button', { name: '관련 본문' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(c.list).toHaveBeenCalledTimes(1);
  });

  it('says so when nothing was found', async () => {
    const c = fake(async () => ({ items: [], degraded: [] }));
    render(
      <RelatedSources
        workspaceId={WS}
        target={target}
        gate={gate}
        client={c}
        searchClient={search}
      />,
    );
    await expand();
    expect(await screen.findByText('관련 본문을 찾지 못했습니다.')).toBeInTheDocument();
  });

  it('shows the keyword-only notice next to the rows', async () => {
    const c = fake(async () => ({ items: [source()], degraded: ['dense_unavailable'] }));
    render(
      <RelatedSources
        workspaceId={WS}
        target={target}
        gate={gate}
        client={c}
        searchClient={search}
      />,
    );
    await expand();
    expect(await screen.findByText(/키워드 결과만 표시합니다/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: '관련 본문' })).toBeInTheDocument();
  });

  it('shows an alert and reads again on 다시 시도', async () => {
    const list = vi
      .fn<RelatedClient['list']>()
      .mockRejectedValueOnce(new client.RelatedApiError('failed', 503))
      .mockResolvedValue({ items: [source()], degraded: [] });
    render(
      <RelatedSources
        workspaceId={WS}
        target={target}
        gate={gate}
        client={{ list, shared: vi.fn() }}
        searchClient={search}
      />,
    );
    await expand();
    expect(await screen.findByRole('alert')).toHaveTextContent('관련 본문을 불러오지 못했습니다.');
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(await screen.findByRole('list', { name: '관련 본문' })).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('opens the excerpt panel with the whole passage from a row', async () => {
    const c = fake(async () => ({ items: [source()], degraded: [] }));
    render(
      <RelatedSources
        workspaceId={WS}
        target={target}
        gate={gate}
        client={c}
        searchClient={search}
      />,
    );
    await expand();
    const list = await screen.findByRole('list', { name: '관련 본문' });
    await userEvent.click(within(list).getByRole('button', { name: /가나다/ }));
    const dialog = await screen.findByRole('dialog', { name: '본문 발췌' });
    // Every block of the passage, in order — not only the first.
    await waitFor(() => expect(dialog).toHaveTextContent('전체 구절의 뒷부분'));
    expect(dialog).toHaveTextContent(/물이 증발한다\.\s*둘째 블록/);
    expect(search.block).toHaveBeenCalledWith(DOC, 'b-1', REV);
    expect(search.block).toHaveBeenCalledWith(DOC, 'b-2', REV);
  });
});

describe('RELSRC-01 long passage', () => {
  it('shows every block of a 13-block passage in order', async () => {
    const ids = Array.from({ length: 13 }, (_, i) => `c-${i + 1}`);
    const block = vi.fn(async (_doc: string, id: string) => ({ text: `블록 ${id} 본문` }) as never);
    const c = fake(async () => ({ items: [source({ block_ids: ids })], degraded: [] }));
    render(
      <RelatedSources
        workspaceId={WS}
        target={target}
        gate={gate}
        client={c}
        searchClient={{ block }}
      />,
    );
    await expand();
    const list = await screen.findByRole('list', { name: '관련 본문' });
    await userEvent.click(within(list).getByRole('button', { name: /가나다/ }));
    const dialog = await screen.findByRole('dialog', { name: '본문 발췌' });
    await waitFor(() => expect(dialog).toHaveTextContent('블록 c-13 본문'));
    for (const id of ids) expect(block).toHaveBeenCalledWith(DOC, id, REV);
    const text = dialog.textContent ?? '';
    const at = ids.map((id) => text.indexOf(`블록 ${id} 본문`));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

describe('RELSRC-01 guest', () => {
  it('is collapsed without a request; the expand shows the stored list read-only', async () => {
    const stored: RelatedClient = {
      list: vi.fn(),
      shared: vi.fn().mockResolvedValue([source()]),
    };
    render(<SharedRelatedSources shareId="share-1" questionId={ID} client={stored} />);
    expect(screen.getByRole('button', { name: '관련 본문' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(stored.shared).not.toHaveBeenCalled();
    await expand();
    const list = await screen.findByRole('list', { name: '관련 본문' });
    expect(within(list).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
    expect(stored.list).not.toHaveBeenCalled();
    expect(stored.shared).toHaveBeenCalledTimes(1);
  });

  it('says nothing was found when there is no stored list', async () => {
    const none: RelatedClient = { list: vi.fn(), shared: vi.fn().mockResolvedValue(null) };
    render(<SharedRelatedSources shareId="share-1" questionId={ID} client={none} />);
    expect(none.shared).not.toHaveBeenCalled();
    await expand();
    expect(await screen.findByText('관련 본문을 찾지 못했습니다.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
  });
});
