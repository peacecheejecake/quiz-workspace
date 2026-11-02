// CHREDIST-01 (UX9-REDIST-W): the 챕터 재분배 dialog's pure model and browser API.
import { describe, expect, it, vi } from 'vitest';
import {
  applyItems,
  classifyRedistFailure,
  createRedistributionApi,
  movePlan,
  NO_TARGET_CHAPTER,
  previewSummary,
  redistributionGroups,
  targetOptions,
  type RedistributionList,
  type RedistributionPreview,
} from '../src/lib/questions/redistribution';

const CH1 = '11111111-1111-4111-8111-111111111111';
const CH2 = '22222222-2222-4222-8222-222222222222';
const Q = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function question(n: number, chapter: string | null, source: 'manual' | 'auto' = 'auto') {
  return {
    question_id: Q(n),
    chapter_id: chapter,
    question_number: n,
    question_type: 'MCQ' as const,
    label: chapter === CH1 ? `1장 ${n}번` : chapter === CH2 ? `2장 ${n}번` : `${n}번`,
    stem_preview: `문제 ${n}\n  발문`,
    chapter_source: source,
  };
}

const LIST: RedistributionList = {
  items: [question(1, CH1), question(2, CH1, 'manual'), question(3, CH2), question(4, null)],
  chapters: [
    { id: CH1, number: 1, title: '1장 물의 순환', document_id: 'd1', question_count: 2 },
    { id: CH2, number: 2, title: '2장 정수 처리', document_id: 'd1', question_count: 1 },
    { id: null, number: null, title: '챕터 없음', document_id: null, question_count: 1 },
  ],
  targets: [
    {
      document_id: 'd1',
      document_title: '교재',
      chapters: [
        { id: CH1, title: '1장 물의 순환', depth: 1 },
        { id: CH2, title: '2장 정수 처리', depth: 1 },
      ],
    },
  ],
};

describe('CHREDIST-01 model', () => {
  it('groups the list in its order, labels rows without a chapter and badges manual rows', () => {
    const groups = redistributionGroups(LIST);
    expect(groups.map((g) => [g.key, g.title, g.questions.length])).toEqual([
      [CH1, '1장 물의 순환', 2],
      [CH2, '2장 정수 처리', 1],
      ['none', '챕터 없음', 1],
    ]);
    expect(groups[0]?.questions.map((q) => [q.number, q.badge])).toEqual([
      ['1장 1번', undefined],
      ['1장 2번', '직접 정함'],
    ]);
    expect(groups[2]?.questions[0]?.number).toBe('챕터 없음 4번');
    expect(groups[0]?.questions[0]?.preview).toBe('문제 1 발문');
  });

  it('offers 챕터 없음 first, then the chapters (document titles only with several books)', () => {
    expect(targetOptions(LIST).map((o) => [o.value, o.title, o.documentTitle])).toEqual([
      [NO_TARGET_CHAPTER, '챕터 없음', null],
      [CH1, '1장 물의 순환', null],
      [CH2, '2장 정수 처리', null],
    ]);
    const two = {
      ...LIST,
      targets: [...LIST.targets, { document_id: 'd2', document_title: '다른 책', chapters: [] }],
    };
    expect(targetOptions(two)[1]?.documentTitle).toBe('교재');
  });

  it('moves only the selected questions not in the target yet, with the chapter each showed', () => {
    const selected = new Set([Q(1), Q(3), Q(4), Q(9)]);
    expect(movePlan(LIST, selected, null)).toEqual({ selected: 3, already: 0, items: [] });
    expect(movePlan(LIST, selected, CH2)).toEqual({
      selected: 3,
      already: 1,
      items: [
        { question_id: Q(1), chapter_id: CH2, expected_chapter_id: CH1 },
        { question_id: Q(4), chapter_id: CH2, expected_chapter_id: null },
      ],
    });
    expect(movePlan(LIST, new Set([Q(4)]), NO_TARGET_CHAPTER).items).toEqual([]);
    expect(movePlan(LIST, new Set([Q(1)]), NO_TARGET_CHAPTER).items).toEqual([
      { question_id: Q(1), chapter_id: null, expected_chapter_id: CH1 },
    ]);
  });

  const PREVIEW: RedistributionPreview = {
    items: [
      {
        question_id: Q(1),
        number_label: '1장 1번',
        stem_preview: '문제 1',
        current_chapter: { id: CH1, title: '1장 물의 순환', document_id: 'd1' },
        recommended_chapter: { id: CH2, title: '2장 정수 처리', document_id: 'd1' },
        reason: 'matched',
      },
      {
        question_id: Q(4),
        number_label: '4번',
        stem_preview: '문제 4',
        current_chapter: null,
        recommended_chapter: { id: CH1, title: '1장 물의 순환', document_id: 'd1' },
        reason: 'source_in_book',
      },
    ],
    unchanged: 1,
    no_recommendation: { no_source: 1, ambiguous: 2 },
    skipped_manual: 0,
  };

  it('summarises the preview without zero parts and applies only the checked rows', () => {
    expect(previewSummary(PREVIEW)).toBe('바뀔 문제 2개 · 그대로 1개 · 추천 없음 3개');
    expect(
      previewSummary({ ...PREVIEW, unchanged: 0, no_recommendation: {}, skipped_manual: 2 }),
    ).toBe('바뀔 문제 2개 · 직접 정한 챕터라 건너뜀 2개');
    expect(applyItems(PREVIEW.items, new Set([Q(4)]))).toEqual([
      { question_id: Q(4), chapter_id: CH1, expected_chapter_id: null },
    ]);
  });

  it('treats a changed, archived or deleted question as one refused move', () => {
    const type = (t: string) => ({ type: `urn:quiz-workspace:problem:${t}` });
    expect(classifyRedistFailure(409, type('chapter-changed'))).toBe('changed');
    expect(classifyRedistFailure(409, type('question-not-confirmed'))).toBe('changed');
    expect(classifyRedistFailure(404, undefined)).toBe('changed');
    expect(classifyRedistFailure(403, type('workspace-archived'))).toBe('archived');
    expect(classifyRedistFailure(403, type('insufficient-role'))).toBe('forbidden');
    expect(classifyRedistFailure(422, type('chapter-invalid'))).toBe('invalid');
    expect(classifyRedistFailure(500, undefined)).toBe('unavailable');
  });
});

describe('CHREDIST-01 browser API', () => {
  function fake(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status }));
  }

  it('sends the move with its Idempotency-Key to the relay route', async () => {
    const fetchImpl = fake(200, { moved: 1, unchanged: 0 });
    const api = createRedistributionApi('ws-1', fetchImpl);
    const items = [{ question_id: Q(1), chapter_id: CH2, expected_chapter_id: CH1 }];
    expect(await api.assign('manual', items, 'key-12345678')).toEqual({
      ok: true,
      data: { moved: 1, unchanged: 0 },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/workspaces/ws-1/questions/chapter-assignments');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('key-12345678');
    expect(JSON.parse(init.body as string)).toEqual({ source: 'manual', items });
  });

  it('previews the selection or everything', async () => {
    const fetchImpl = fake(200, { items: [] });
    const api = createRedistributionApi('ws-1', fetchImpl);
    await api.preview('all', false);
    await api.preview([Q(1)], true);
    const bodies = fetchImpl.mock.calls.map((c) =>
      JSON.parse((c as unknown as [string, RequestInit])[1].body as string),
    );
    expect(bodies).toEqual([
      { all: true, include_manual: false },
      { question_ids: [Q(1)], include_manual: true },
    ]);
  });

  it('reports a refused move and a network failure', async () => {
    const refused = createRedistributionApi(
      'ws-1',
      fake(409, { type: 'urn:quiz-workspace:problem:chapter-changed', question_ids: [Q(1)] }),
    );
    expect(await refused.assign('manual', [], 'k')).toEqual({ ok: false, kind: 'changed' });
    const offline = createRedistributionApi(
      'ws-1',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    expect(await offline.list()).toEqual({ ok: false, kind: 'unavailable' });
  });
});
