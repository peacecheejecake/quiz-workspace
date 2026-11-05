// QSEARCH-CACHE unit tests: client-side in-memory OverviewCache, abortable fetchQuestionOverview,
// and the extended BFF route GET /api/workspaces/[workspaceId]/questions/overview.
import { describe, expect, it, vi } from 'vitest';
import type * as Bff from '../src/lib/documents/bff';
import {
  answerFreeOverview,
  fetchQuestionOverview,
  OVERVIEW_CACHE_MAX_ENTRIES,
  OVERVIEW_CACHE_TTL_MS,
  OverviewCache,
  overviewBffUrl,
  overviewCacheKey,
} from '../src/lib/questions/overview-cache';
import type { QuestionOverview } from '../src/lib/questions/overview-data';
import {
  EMPTY_OVERVIEW_FILTERS,
  OVERVIEW_SEARCH_MAX,
  type OverviewFilters,
} from '../src/lib/questions/overview-filters';

const relay = vi.hoisted(() => ({ relayToApi: vi.fn() }));
vi.mock('@/lib/documents/bff', async (original) => ({
  ...(await original<typeof Bff>()),
  relayToApi: relay.relayToApi,
}));

const route = await import('../src/app/api/workspaces/[workspaceId]/questions/overview/route');

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const VIEWER_A = '22222222-2222-4222-8222-222222222222';
const VIEWER_B = '33333333-3333-4333-8333-333333333333';
const CHAPTER_ID = '44444444-4444-4444-8444-444444444444';
const QUESTION_ID = '55555555-5555-4555-8555-555555555555';

const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;

function sampleOverview(label = 'chlorine'): QuestionOverview {
  return {
    counts: {
      total: 1,
      unseen: 1,
      viewed: 0,
      incorrect: 0,
      correct: 0,
      retry: 0,
      favorite: 0,
    },
    chapters: [
      {
        id: CHAPTER_ID,
        number: 1,
        title: '1장 수질',
        document_id: null,
        question_count: 1,
      },
    ],
    items: [
      {
        question_id: QUESTION_ID,
        chapter_id: CHAPTER_ID,
        question_number: 1,
        question_type: 'MCQ',
        status: 'unseen',
        is_favorite: false,
        needs_retry: false,
        last_graded_result: null,
        is_pending_grading: false,
        preview: `샘플 문제: ${label}`,
      },
    ],
  };
}

describe('OverviewCache', () => {
  it('uses canonical filter keys and ignores non-filter query params such as question=', () => {
    expect(OVERVIEW_CACHE_TTL_MS).toBe(5 * 60_000);
    expect(OVERVIEW_CACHE_MAX_ENTRIES).toBe(50);
    expect(overviewCacheKey(EMPTY_OVERVIEW_FILTERS)).toBe('');
    expect(overviewCacheKey(`?question=${QUESTION_ID}`)).toBe('');
    expect(
      overviewCacheKey(
        '?status=correct&q=+염소+&status=unseen&status=correct&question=' + QUESTION_ID,
      ),
    ).toBe('?q=%EC%97%BC%EC%86%8C&status=unseen&status=correct');
  });

  it('copies only documented answer-free fields and never retains secret fields', () => {
    const base = sampleOverview('secret-check');
    const dirty = {
      ...base,
      secret_workspace_token: 'never-keep',
      counts: { ...base.counts, hidden: 99 },
      chapters: base.chapters.map((c) => ({ ...c, raw_markdown: 'book body' })),
      items: base.items.map((i) => ({
        ...i,
        correct_option_id: 'opt-1',
        explanation: '정답 해설',
        rubric: '채점 기준',
      })),
    } as unknown as QuestionOverview;

    const clean = answerFreeOverview(dirty);
    expect(clean).toEqual(sampleOverview('secret-check'));
    expect('secret_workspace_token' in (clean as Record<string, unknown>)).toBe(false);
    expect('hidden' in (clean.counts as Record<string, unknown>)).toBe(false);
    expect('raw_markdown' in (clean.chapters[0] as Record<string, unknown>)).toBe(false);
    expect('correct_option_id' in (clean.items[0] as Record<string, unknown>)).toBe(false);
    expect('explanation' in (clean.items[0] as Record<string, unknown>)).toBe(false);
    expect('rubric' in (clean.items[0] as Record<string, unknown>)).toBe(false);
  });

  it('scopes identity to workspaceId + viewerId, enforces TTL and LRU maxEntries, and clears', () => {
    let clock = 1_000;
    const cache = new OverviewCache(WORKSPACE_ID.toUpperCase(), VIEWER_A.toUpperCase(), {
      ttlMs: 5_000,
      maxEntries: 3,
      now: () => clock,
    });

    expect(cache.matches(WORKSPACE_ID, VIEWER_A)).toBe(true);
    expect(cache.matches(WORKSPACE_ID, VIEWER_B)).toBe(false);
    expect(cache.matches(WORKSPACE_ID, null)).toBe(false);
    expect(cache.matches(CHAPTER_ID, VIEWER_A)).toBe(false);

    cache.put(EMPTY_OVERVIEW_FILTERS, sampleOverview('all'));
    cache.put({ ...EMPTY_OVERVIEW_FILTERS, q: 'one' }, sampleOverview('one'));
    cache.put({ ...EMPTY_OVERVIEW_FILTERS, q: 'two' }, sampleOverview('two'));
    expect(cache.size).toBe(3);

    // Touching `""` refreshes its LRU order, so inserting a 4th entry evicts `q=one` instead.
    expect(cache.get('')?.items[0]?.preview).toBe('샘플 문제: all');
    cache.put({ ...EMPTY_OVERVIEW_FILTERS, q: 'three' }, sampleOverview('three'));
    expect(cache.size).toBe(3);
    expect(cache.get('?q=one')).toBeNull();
    expect(cache.get('')?.items[0]?.preview).toBe('샘플 문제: all');
    expect(cache.get('?q=three')?.items[0]?.preview).toBe('샘플 문제: three');

    // Past TTL: entries expire and are dropped on read.
    clock += 5_000;
    expect(cache.get('')).toBeNull();
    expect(cache.get('?q=two')).toBeNull();

    cache.put('?q=fresh', sampleOverview('fresh'));
    expect(cache.size).toBe(2); // expired `?q=three` still in map until read or clear
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('?q=fresh')).toBeNull();
  });
});

describe('fetchQuestionOverview', () => {
  it('builds the BFF URL, strips extra fields on 200, and classifies aborts and errors', async () => {
    const filters: OverviewFilters = {
      ...EMPTY_OVERVIEW_FILTERS,
      chapter: CHAPTER_ID,
      q: '염소',
      status: ['unseen'],
    };
    expect(overviewBffUrl(WORKSPACE_ID, filters)).toBe(
      `/api/workspaces/${WORKSPACE_ID}/questions/overview?chapter=${CHAPTER_ID}&q=%EC%97%BC%EC%86%8C&status=unseen`,
    );

    const base = sampleOverview('염소');
    const okFetch: typeof fetch = vi.fn().mockResolvedValue(
      Response.json({
        ...base,
        items: base.items.map((i) => ({ ...i, explanation: 'strip-me' })),
      }),
    );
    const ok = await fetchQuestionOverview(WORKSPACE_ID, filters, undefined, okFetch);
    expect(ok).toEqual({ ok: true, data: sampleOverview('염소') });

    const controller = new AbortController();
    const abortFetch: typeof fetch = vi.fn().mockImplementation((_input, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const pending = fetchQuestionOverview(WORKSPACE_ID, filters, controller.signal, abortFetch);
    controller.abort();
    expect(await pending).toEqual({ ok: false, aborted: true });

    const unavailable = await fetchQuestionOverview(
      WORKSPACE_ID,
      filters,
      undefined,
      vi.fn().mockResolvedValue(new Response('bad gateway', { status: 503 })),
    );
    expect(unavailable).toEqual({ ok: false, aborted: false, kind: 'unavailable' });

    const unauth = await fetchQuestionOverview(
      WORKSPACE_ID,
      filters,
      undefined,
      vi.fn().mockResolvedValue(new Response('{}', { status: 401 })),
    );
    expect(unauth).toEqual({ ok: false, aborted: false, kind: 'unauthenticated' });
  });
});

describe('GET /api/workspaces/[workspaceId]/questions/overview BFF route', () => {
  it('validates and forwards chapter, q, type, status, favorite, retry and request.signal', async () => {
    relay.relayToApi.mockResolvedValue(Response.json(sampleOverview()));
    const controller = new AbortController();
    const req = new Request(
      `http://web.test/api/workspaces/${WORKSPACE_ID}/questions/overview?chapter=${CHAPTER_ID.toUpperCase()}&type=MCQ&q=+%EC%97%BC%EC%86%8C+chlorine+&status=unseen&status=unseen&favorite=true&retry=false&ignored=1`,
      { signal: controller.signal },
    );
    const res = await route.GET(req, ctx({ workspaceId: WORKSPACE_ID }));
    expect(res.status).toBe(200);
    expect(relay.relayToApi).toHaveBeenLastCalledWith(
      `/workspaces/${WORKSPACE_ID}/questions/overview?chapter=${CHAPTER_ID}&type=MCQ&q=%EC%97%BC%EC%86%8C+chlorine&status=unseen&favorite=true&retry=false`,
      { method: 'GET', signal: req.signal },
    );
    controller.abort();
    expect(req.signal.aborted).toBe(true);

    await route.GET(
      new Request(`http://web.test/api/workspaces/${WORKSPACE_ID}/questions/overview?chapter=none`),
      ctx({ workspaceId: WORKSPACE_ID }),
    );
    expect(relay.relayToApi).toHaveBeenLastCalledWith(
      `/workspaces/${WORKSPACE_ID}/questions/overview?chapter=none`,
      { method: 'GET', signal: expect.any(AbortSignal) },
    );
  });

  it('rejects malformed workspaceId, chapter, empty/whitespace q, and overlong q before FastAPI', async () => {
    relay.relayToApi.mockClear();

    const badWs = await route.GET(
      new Request('http://web.test/api/workspaces/not-a-uuid/questions/overview'),
      ctx({ workspaceId: 'not-a-uuid' }),
    );
    expect(badWs.status).toBe(404);

    for (const badQuery of [
      'chapter=not-a-uuid',
      'chapter=',
      'q=',
      'q=   ',
      `q=${'가'.repeat(OVERVIEW_SEARCH_MAX + 1)}`,
      'type=INVALID',
      'status=unknown',
      'favorite=yes',
    ]) {
      const res = await route.GET(
        new Request(
          `http://web.test/api/workspaces/${WORKSPACE_ID}/questions/overview?${badQuery}`,
        ),
        ctx({ workspaceId: WORKSPACE_ID }),
      );
      expect(res.status, badQuery).toBe(400);
    }
    expect(relay.relayToApi).not.toHaveBeenCalled();

    // Exactly 200 trimmed chars is accepted.
    relay.relayToApi.mockResolvedValueOnce(Response.json(sampleOverview()));
    const maxQ = 'a'.repeat(OVERVIEW_SEARCH_MAX);
    const okMax = await route.GET(
      new Request(`http://web.test/api/workspaces/${WORKSPACE_ID}/questions/overview?q=+${maxQ}+`),
      ctx({ workspaceId: WORKSPACE_ID }),
    );
    expect(okMax.status).toBe(200);
    expect(relay.relayToApi).toHaveBeenCalledTimes(1);
  });
});
