// @vitest-environment jsdom
// HILITE-01 (docs/screens/highlights.md) on the web side: the `내 하이라이트` view model (order,
// filters, labels, explanation footnotes, explanation blocks), the relay client (problem kinds,
// Idempotency-Key), `MyHighlightsSection` (filters, delete without confirmation + 되돌리기) and
// HILITE-01-C09's import check: the note body and the explanation use the same kit tool.
import './dom-setup';
import { readFileSync } from 'node:fs';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@quiz/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChapterNoteBody } from '../src/components/questions/notes/chapter-note-body';
import {
  MyHighlightsSection,
  type HighlightFilters,
} from '../src/components/questions/notes/my-highlights-section';
import { useState } from 'react';
import {
  useHighlightStore,
  type HighlightItems,
  type HighlightStore,
} from '../src/components/questions/notes/highlight-tool';
import {
  classifyHighlightFailure,
  createHighlight,
  deleteHighlight,
  getQuestionHighlights,
  HIGHLIGHT_PROBLEMS,
  recolorHighlight,
  restoreHighlight,
} from '../src/lib/highlights/client';
import {
  canGoTo,
  explanationBlocks,
  explanationHighlightsOf,
  footnoteNumbers,
  highlightFootnote,
  matchesFilters,
  orderRows,
  rowBadge,
  rowMeta,
} from '../src/lib/highlights/model';
import type { MyHighlight } from '../src/lib/notes/model';

const Q1 = '22222222-2222-4222-8222-000000000001';
const Q2 = '22222222-2222-4222-8222-000000000002';
const N1 = '33333333-3333-4333-8333-000000000001';
const N2 = '33333333-3333-4333-8333-000000000002';

let seq = 0;
function noteHl(noteId: string, version: number, extra: Partial<MyHighlight> = {}): MyHighlight {
  seq += 1;
  return {
    id: `44444444-4444-4444-8444-${String(seq).padStart(12, '0')}`,
    color: 'yellow',
    version: 1,
    target: { kind: 'note', chapter_note_id: noteId, note_version: version },
    anchor: { block: 's0.i0', start: 0, end: 2 },
    quote: `노트 인용 ${seq}`,
    anchor_status: 'exact',
    anchor_current: { block: 's0.i0', start: 0, end: 2 },
    question: null,
    created_at: '2026-11-02T00:00:00Z',
    updated_at: '2026-11-02T00:00:00Z',
    ...extra,
  };
}

function explanationHl(questionId: string, extra: Partial<MyHighlight> = {}): MyHighlight {
  seq += 1;
  return {
    id: `55555555-5555-4555-8555-${String(seq).padStart(12, '0')}`,
    color: 'pink',
    version: 1,
    target: {
      kind: 'explanation',
      question_id: questionId,
      question_revision_id: '66666666-6666-4666-8666-666666666666',
    },
    anchor: { block: 'p0', start: 3, end: 6 },
    quote: '라마바',
    anchor_status: 'exact',
    anchor_current: { block: 'p0', start: 3, end: 6 },
    question: { question_id: questionId, number_label: '1번', stem_preview: '첫 문제 발문' },
    created_at: '2026-11-02T00:00:00Z',
    updated_at: '2026-11-02T00:00:00Z',
    ...extra,
  };
}

describe('내 하이라이트 view model', () => {
  it('labels rows by color, source and version or question', () => {
    expect(rowMeta(noteHl(N1, 1))).toBe('노랑 · 노트 · 버전 1');
    expect(rowMeta(explanationHl(Q1))).toBe('분홍 · 해설 · 1번');
  });

  it('orders notes newest version first in body order, then explanations', () => {
    const old = noteHl(N1, 1);
    const a = noteHl(N2, 2, { anchor: { block: 's0.i0', start: 5, end: 7 } });
    const b = noteHl(N2, 2, { anchor: { block: 's0.i1', start: 0, end: 2 } });
    const first = noteHl(N2, 2, { anchor: { block: 's0.i0', start: 0, end: 2 } });
    const e = explanationHl(Q1);
    // A highlight made here (appended locally) sorts into its place.
    expect(orderRows([e, old, b, a, first]).map((h) => h.id)).toEqual(
      [first, a, b, old, e].map((h) => h.id),
    );
  });

  it('filters by source and color', () => {
    const rows = [noteHl(N1, 1), explanationHl(Q1, { color: 'yellow' }), explanationHl(Q2)];
    const kept = (source: 'all' | 'note' | 'explanation', color: 'all' | 'yellow') =>
      rows.filter((h) => matchesFilters(h, source, color)).length;
    expect([kept('all', 'all'), kept('all', 'yellow'), kept('explanation', 'yellow')]).toEqual([
      3, 2, 1,
    ]);
    expect(kept('note', 'all')).toBe(1);
  });

  it('numbers explanation footnotes [^hk] in display order', () => {
    const a = explanationHl(Q1);
    const b = explanationHl(Q2, {
      question: { question_id: Q2, number_label: '2번', stem_preview: '[E2E] 둘째 발문' },
    });
    const numbers = footnoteNumbers([noteHl(N1, 1), a, b]);
    expect([numbers.get(a.id), numbers.get(b.id)]).toEqual([1, 2]);
    expect(highlightFootnote(a, 1)).toBe('[^h1] 1번 — 첫 문제 발문');
  });

  it('a lost position has the badge and no 위치로 이동', () => {
    const lost = explanationHl(Q1, { anchor_status: 'missing', anchor_current: null });
    expect(rowBadge(lost)).toBe('해설이 바뀌어 위치를 찾을 수 없습니다');
    expect(canGoTo(lost)).toBe(false);
    expect(canGoTo(explanationHl(Q1))).toBe(true);
    expect(rowBadge(noteHl(N1, 1))).toBeNull();
  });

  it('splits explanations into p<i> blocks and draws only found explanation highlights', () => {
    expect(explanationBlocks('가나다\n\n라마바\n사아자')).toEqual([
      { id: 'p0', text: '가나다' },
      { id: 'p1', text: '라마바\n사아자' },
    ]);
    const found = explanationHl(Q1, {
      anchor_status: 'relocated',
      anchor_current: { block: 'p0', start: 9, end: 12 },
    });
    const lost = explanationHl(Q1, { anchor_status: 'missing', anchor_current: null });
    expect(explanationHighlightsOf([found, lost, explanationHl(Q2)], Q1)).toEqual([
      { id: found.id, block: 'p0', start: 9, end: 12, color: 'pink' },
    ]);
  });
});

describe('HILITE-01 highlight store', () => {
  it('keeps a change made before the list arrived and drops the older read', async () => {
    const pending: ((items: HighlightItems) => void)[] = [];
    const load = vi.fn(() => new Promise<HighlightItems>((resolve) => pending.push(resolve)));
    const { result } = renderHook(() => useHighlightStore(load, 'k'));
    expect(result.current.items).toBeUndefined();
    const made = explanationHl(Q1);
    act(() => result.current.update((list) => [...list, made]));
    expect(result.current.items?.map((h) => h.id)).toEqual([made.id]);
    // The read that started before the change answers without it: it is not applied.
    await act(async () => pending[0]?.([]));
    expect(result.current.items?.map((h) => h.id)).toEqual([made.id]);
    // A newer read is made instead, and its answer is.
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await act(async () => pending[1]?.([made]));
    expect(result.current.items?.map((h) => h.id)).toEqual([made.id]);
  });
});

describe('highlight relay client', () => {
  it('classifies the highlight problems', () => {
    const kind = (status: number, type?: string) => classifyHighlightFailure(status, { type });
    expect(kind(409, HIGHLIGHT_PROBLEMS.overlap)).toBe('overlap');
    expect(kind(409, HIGHLIGHT_PROBLEMS.changed)).toBe('changed');
    expect(kind(409, HIGHLIGHT_PROBLEMS.notRestorable)).toBe('notRestorable');
    expect(kind(404)).toBe('gone');
    expect(kind(500)).toBe('failed');
  });

  it('creates through the relay with the Idempotency-Key and a JSON body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(explanationHl(Q1), { status: 201 }),
    );
    await createHighlight(
      {
        target: { kind: 'explanation', question_id: Q1 },
        anchor: { block: 'p0', start: 0, end: 3 },
        color: 'blue',
        replace_ids: ['x'],
      },
      'key-1',
      fetchImpl,
    );
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/my-highlights');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['idempotency-key']).toBe('key-1');
    expect(JSON.parse(String(init?.body))).toMatchObject({ color: 'blue', replace_ids: ['x'] });
  });

  it('sends every write with keepalive so a navigation right after it never drops the save', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json(explanationHl(Q1), { status: 200 }),
    );
    await createHighlight(
      {
        target: { kind: 'explanation', question_id: Q1 },
        anchor: { block: 'p0', start: 0, end: 3 },
        color: 'yellow',
      },
      'key-2',
      fetchImpl,
    );
    await recolorHighlight('h1', 'pink', 1, fetchImpl);
    await deleteHighlight('h1', fetchImpl);
    await restoreHighlight('h1', fetchImpl);
    expect(fetchImpl.mock.calls.map(([, init]) => [init?.method, init?.keepalive])).toEqual([
      ['POST', true],
      ['PATCH', true],
      ['DELETE', true],
      ['POST', true],
    ]);
    // Reads stay ordinary requests.
    await getQuestionHighlights(Q1, undefined, fetchImpl);
    expect(fetchImpl.mock.calls.at(-1)?.[1]?.keepalive).toBeUndefined();
  });
});

describe('MyHighlightsSection', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json(explanationHl(Q1), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderSection(items: MyHighlight[]) {
    let list: readonly MyHighlight[] = items;
    const store: HighlightStore = {
      get items() {
        return list;
      },
      update: (change) => {
        list = change(list);
        view.rerender(section());
      },
      reload: vi.fn(),
    };
    function Section() {
      const [filters, setFilters] = useState<HighlightFilters>({ source: 'all', color: 'all' });
      return (
        <MyHighlightsSection
          store={store}
          matchesOf={() => []}
          onGoTo={vi.fn()}
          renderFootnote={(_h, line) => line}
          filters={filters}
          onFiltersChange={setFilters}
        />
      );
    }
    const section = () => <Section />;
    const view = render(section(), { wrapper: ToastProvider });
    return view;
  }

  it('filters with aria-pressed chips and lists explanation rows with their footnote', async () => {
    const user = userEvent.setup();
    renderSection([noteHl(N1, 1), explanationHl(Q1)]);
    const region = screen.getByRole('region', { name: '내 하이라이트 (2)' });
    const list = within(region).getByRole('list', { name: '내 하이라이트 목록' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(list.textContent).toContain('[^h1] 1번 — 첫 문제 발문');
    const explanation = within(within(region).getByRole('group', { name: '출처' })).getByRole(
      'button',
      { name: '해설' },
    );
    await user.click(explanation);
    expect(explanation.getAttribute('aria-pressed')).toBe('true');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    const yellow = within(within(region).getByRole('group', { name: '색' })).getByRole('button', {
      name: '노랑',
    });
    await user.click(yellow);
    expect(within(region).getByText('고른 조건의 하이라이트가 없습니다.')).toBeTruthy();
    expect(within(region).queryByRole('link')).toBeNull();
  });

  it('deletes without confirmation and offers 되돌리기 in a toast', async () => {
    const user = userEvent.setup();
    const target = noteHl(N1, 1);
    renderSection([target, explanationHl(Q1)]);
    await user.click(screen.getAllByRole('button', { name: '하이라이트 메뉴' })[0] as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: '삭제' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/my-highlights/${target.id}`,
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByText('하이라이트를 지웠습니다')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '내 하이라이트 (1)' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '되돌리기' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/my-highlights/${target.id}/restore`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});

describe('note search over 내 하이라이트 (CHNOTE-02, HILITE-01)', () => {
  it('counts only the explanation rows the filters show', async () => {
    const user = userEvent.setup();
    const store: HighlightStore = {
      items: [noteHl(N1, 1), explanationHl(Q1, { quote: '주의할 점', color: 'pink' })],
      update: vi.fn(),
      reload: vi.fn(),
    };
    render(
      <ChapterNoteBody
        sections={[]}
        footnotes={[]}
        parts="highlights"
        questionHref={() => '#'}
        onOpenQuestion={vi.fn()}
        loadPreview={vi.fn()}
        highlighting={{ store, noteId: null, onGoTo: vi.fn() }}
      />,
      { wrapper: ToastProvider },
    );
    await user.type(screen.getByRole('searchbox', { name: '노트에서 찾기' }), '주의');
    expect(await screen.findByText('1/1')).toBeTruthy();
    // 색 노랑 hides the (pink) explanation row: its quote is no longer a result.
    await user.click(
      within(screen.getByRole('group', { name: '색' })).getByRole('button', { name: '노랑' }),
    );
    expect(await screen.findByText('결과 없음')).toBeTruthy();
  });
});

describe('HILITE-01-C09 one tool for notes and explanations', () => {
  it('the note body and the explanation import the same kit components through one module', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const tool = read('../src/components/questions/notes/highlight-tool.tsx');
    expect(tool).toMatch(/import \{[^}]*HighlightMenu[^}]*\} from '@quiz\/ui'/);
    for (const user of [
      '../src/components/questions/notes/chapter-note-body.tsx',
      '../src/components/questions/viewer/explanation-text.tsx',
    ]) {
      const source = read(user);
      expect(source).toMatch(/HighlightableText[^;]*from '@quiz\/ui'/s);
      expect(source).toContain('useHighlightTool');
      expect(source).not.toMatch(/function HighlightMenu|function HighlightableText/);
    }
  });
});
