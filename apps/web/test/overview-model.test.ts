// QOV-01 view model: heatmap grouping/order, optimistic study state and when it yields to the
// server's overview again.
import { describe, expect, it } from 'vitest';
import {
  applyOverrides,
  findPlaced,
  heatmapChapters,
  optimisticStatus,
  placedTitle,
  placeQuestions,
} from '../src/components/questions/overview/overview-model';
import type { OverviewChapter, OverviewItem } from '../src/lib/questions/overview-data';

const C1 = '11111111-1111-4111-8111-000000000001';
const C2 = '11111111-1111-4111-8111-000000000002';

function item(
  id: string,
  chapter: string | null,
  n: number | null,
  extra: Partial<OverviewItem> = {},
) {
  return {
    question_id: id,
    chapter_id: chapter,
    question_number: n,
    question_type: 'MCQ',
    status: 'unseen',
    is_favorite: false,
    needs_retry: false,
    last_graded_result: null,
    is_pending_grading: false,
    preview: `stem ${id}`,
    ...extra,
  } satisfies OverviewItem;
}

const chapters: OverviewChapter[] = [
  { id: C2, number: 3, title: 'Attention', document_id: null, question_count: 1 },
  { id: C1, number: null, title: '부록', document_id: null, question_count: 1 },
  { id: null, number: null, title: '챕터 없음', document_id: null, question_count: 2 },
];

describe('placeQuestions / heatmapChapters', () => {
  it('groups items in the API chapter order and labels them like the dots', () => {
    const items = [item('a', C2, 12), item('b', C1, 4), item('c', null, null), item('d', null, 7)];
    const placed = placeQuestions(chapters, items);
    expect(placed.map((p) => [p.item.question_id, p.number, p.chapterKey])).toEqual([
      ['a', '12', C2],
      ['b', '4', C1],
      // Unnumbered: position within the chapter.
      ['c', '1', 'none'],
      ['d', '7', 'none'],
    ]);
    expect(placed.map(placedTitle)).toEqual([
      '3장 12번 문제',
      '부록 4번 문제',
      '챕터 없음 1번 문제',
      '챕터 없음 7번 문제',
    ]);
    const groups = heatmapChapters(placed);
    expect(groups.map((g) => [g.id, g.title, g.number, g.questions.length])).toEqual([
      [C2, 'Attention', 3, 1],
      [C1, '부록', undefined, 1],
      ['none', '챕터 없음', undefined, 2],
    ]);
  });

  it('one item = one dot (no duplicates, nothing dropped)', () => {
    const items = Array.from({ length: 100 }, (_, i) => item(`q${i}`, i % 2 ? C1 : null, i + 1));
    const dots = heatmapChapters(placeQuestions(chapters, items)).flatMap((c) => c.questions);
    expect(dots).toHaveLength(100);
    expect(new Set(dots.map((d) => d.id)).size).toBe(100);
  });
});

describe('optimisticStatus', () => {
  const correct = item('a', null, 1, { status: 'correct', last_graded_result: 'correct' });

  it('retry wins over the last result and clearing it returns the result (QOV-01-AC05)', () => {
    expect(optimisticStatus(correct, { needs_retry: true })).toBe('retry');
    const flagged = { ...correct, status: 'retry' as const, needs_retry: true };
    expect(optimisticStatus(flagged, { needs_retry: false })).toBe('correct');
  });

  it('favorite never changes the status (QOV-01-AC03)', () => {
    expect(optimisticStatus(correct, { is_favorite: true })).toBe('correct');
    expect(optimisticStatus(item('b', null, 2), { is_favorite: true })).toBe('unseen');
    const viewed = item('c', null, 3, { status: 'viewed' });
    expect(optimisticStatus(viewed, { needs_retry: false })).toBe('viewed');
  });
});

describe('applyOverrides', () => {
  const server = [item('a', null, 1), item('b', null, 2)];

  it('shows a pending change and a settled one until the server list changes', () => {
    const pending = new Map([['a', { patch: { is_favorite: true }, settledOn: null }]]);
    expect(applyOverrides(server, pending)[0]?.is_favorite).toBe(true);

    const settled = new Map([['a', { patch: { status: 'viewed' as const }, settledOn: server }]]);
    expect(applyOverrides(server, settled)[0]?.status).toBe('viewed');
    // A revalidated overview (new list) is the truth again.
    const fresh = server.map((i) => ({ ...i }));
    expect(applyOverrides(fresh, settled)[0]?.status).toBe('unseen');
    // ... but a change still in flight survives a new list.
    expect(applyOverrides(fresh, pending)[0]?.is_favorite).toBe(true);
  });
});

describe('findPlaced', () => {
  it('places one question as in the unfiltered heatmap (deep links outside the filters)', () => {
    const all = {
      chapters,
      items: [item('a', C2, 12), item('c', null, null), item('d', null, null)],
    };
    expect(findPlaced(all, 'd')).toMatchObject({ number: '2', chapterTitle: '챕터 없음' });
    expect(findPlaced(all, 'zz')).toBeNull();
  });
});
