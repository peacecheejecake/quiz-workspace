// SEARCH-01 pure helpers: highlight segmentation (code point offsets), jump-target refinement,
// address-bar state, warnings copy and the relay client's failure mapping (429 Retry-After, 503).
import { describe, expect, it, vi } from 'vitest';
import {
  classifySearchFailure,
  createSearchClient,
  parseRetryAfter,
  searchBody,
  SearchApiError,
  type ContentBlock,
  type SearchItem,
} from '../src/lib/search/client';
import { segmentHighlights } from '../src/lib/search/highlight';
import { jumpProbe, pickJumpBlock, resolveJumpTarget } from '../src/lib/search/jump';
import {
  degradedMessages,
  mergeContentSearch,
  parseSearchParams,
  pdfLinkFor,
  rateLimitMessage,
  reconcileChapter,
  searchParamsFor,
  warningMessages,
} from '../src/lib/search/state';

const DOC = '11111111-1111-4111-8111-111111111111';
const CHAPTER = '33333333-3333-4333-8333-333333333333';
const REV = '44444444-4444-4444-8444-444444444444';

const render = (segments: ReturnType<typeof segmentHighlights>) =>
  segments.map((s) => (s.term ? `[${s.text}]` : s.passage ? `{${s.text}}` : s.text)).join('');

describe('segmentHighlights', () => {
  it('covers the whole text once, marking passage and terms', () => {
    const text = 'Rain falls. Then chlorine is added.';
    const segments = segmentHighlights(text, [{ start: 12, end: 35 }], [{ start: 17, end: 25 }]);
    expect(segments.map((s) => s.text).join('')).toBe(text);
    expect(segments).toEqual([
      { text: 'Rain falls. ', passage: false, term: false },
      { text: 'Then ', passage: true, term: false },
      { text: 'chlorine', passage: true, term: true },
      { text: ' is added.', passage: true, term: false },
    ]);
  });

  it('treats offsets as code points, not UTF-16 units', () => {
    // "😀" is one character for the API (Python) but two UTF-16 units in JS.
    const text = '😀 염소 소독';
    const segments = segmentHighlights(text, [], [{ start: 2, end: 4 }]);
    expect(render(segments)).toBe('😀 [염소] 소독');
  });

  it('merges overlapping ranges and ignores invalid or out-of-range ones', () => {
    const text = 'abcdefghij';
    const segments = segmentHighlights(
      text,
      [
        { start: 2, end: 5 },
        { start: 4, end: 7 },
        { start: 8, end: 99 },
      ],
      [
        { start: 6, end: 3 },
        { start: -5, end: 1 },
        { start: Number.NaN, end: 4 },
      ],
    );
    expect(render(segments)).toBe('[a]b{cdefg}h{ij}');
    expect(segments.map((s) => s.text).join('')).toBe(text);
  });

  it('returns no segments for empty text and one plain segment without ranges', () => {
    expect(segmentHighlights('', [{ start: 0, end: 3 }], [])).toEqual([]);
    expect(segmentHighlights('plain', [], [])).toEqual([
      { text: 'plain', passage: false, term: false },
    ]);
  });
});

const item = (overrides: Partial<SearchItem> = {}): SearchItem =>
  ({
    document_id: DOC,
    revision_id: REV,
    block_id: 'p1',
    block_ids: ['p1', 'p2'],
    page: 4,
    text: 'Filters catch particles.\n\nFinally chlorine is added to kill microbes.',
    highlights: [{ start: 0, end: 69 }],
    term_highlights: [{ start: 34, end: 42 }],
    ...overrides,
  }) as SearchItem;

const block = (block_id: string, text: string, page: number): ContentBlock =>
  ({ block_id, text, page, locations: [{ page, bbox: null }] }) as unknown as ContentBlock;

describe('jump target', () => {
  it('probes from the start of the line holding the first term inside the passage', () => {
    expect(jumpProbe(item())).toBe('Finally chlorine');
  });

  it('falls back to the first line of the passage without terms', () => {
    expect(jumpProbe(item({ term_highlights: [] }))).toBe('Filters catch particles.');
    expect(jumpProbe(item({ term_highlights: [], highlights: [] }))).toBeNull();
  });

  it('ignores terms outside the matched passage', () => {
    const probe = jumpProbe(
      item({
        highlights: [{ start: 26, end: 69 }],
        term_highlights: [
          { start: 0, end: 7 },
          { start: 34, end: 42 },
        ],
      }),
    );
    expect(probe).toBe('Finally chlorine');
  });

  it('picks the block whose text contains the probe', () => {
    const blocks = [
      block('p1', 'Filters catch particles.', 4),
      block('p2', 'Finally chlorine is added to kill microbes.', 5),
    ];
    expect(pickJumpBlock(blocks, 'Finally chlorine')).toEqual({ blockId: 'p2', page: 5 });
    expect(pickJumpBlock(blocks, 'nowhere')).toBeNull();
  });

  it('reads the matched blocks of the hit revision and falls back to the API location', async () => {
    const reads: string[] = [];
    const client = {
      block: vi.fn(async (_doc: string, id: string, revision: string) => {
        reads.push(`${id}@${revision}`);
        return id === 'p1'
          ? block('p1', 'Filters catch particles.', 4)
          : block('p2', 'Finally chlorine is added to kill microbes.', 4);
      }),
    };
    await expect(resolveJumpTarget(client, item())).resolves.toEqual({ blockId: 'p2', page: 4 });
    expect(reads).toEqual([`p1@${REV}`, `p2@${REV}`]);

    // One matched block: nothing to refine, no reads.
    client.block.mockClear();
    await expect(resolveJumpTarget(client, item({ block_ids: ['p1'] }))).resolves.toEqual({
      blockId: 'p1',
      page: 4,
    });
    expect(client.block).not.toHaveBeenCalled();

    const failing = { block: vi.fn(async () => Promise.reject(new SearchApiError('network'))) };
    await expect(resolveJumpTarget(failing, item())).resolves.toEqual({ blockId: 'p1', page: 4 });
  });
});

describe('search address-bar state', () => {
  it('round-trips a submitted search', () => {
    const q = {
      query: '정수장 염소',
      mode: 'semantic' as const,
      documentId: DOC,
      chapterId: CHAPTER,
      includeQuestionPapers: true,
    };
    const params = Object.fromEntries(new URLSearchParams(searchParamsFor(q)));
    expect(parseSearchParams(params)).toEqual(q);
  });

  it('drops invalid values and a chapter without its document', () => {
    expect(
      parseSearchParams({ q: '  water ', mode: 'fuzzy', document: 'nope', section: CHAPTER }),
    ).toEqual({
      query: 'water',
      mode: 'hybrid',
      documentId: null,
      chapterId: null,
      includeQuestionPapers: false,
    });
    expect(parseSearchParams({ q: 'x'.repeat(5000) }).query).toHaveLength(1000);
    expect(searchParamsFor(parseSearchParams({}))).toBe('');
  });

  it('merges a content search into the home URL and keeps the other keys', () => {
    const merged = mergeContentSearch(
      `?panel=history&chapter=none&status=retry&q=old&mode=keyword&section=${CHAPTER}`,
      {
        query: '염소',
        mode: 'hybrid',
        documentId: DOC,
        chapterId: null,
        includeQuestionPapers: true,
      },
    );
    const params = new URLSearchParams(merged);
    expect(params.get('panel')).toBe('history');
    expect(params.get('chapter')).toBe('none');
    expect(params.get('status')).toBe('retry');
    expect(params.get('q')).toBe('염소');
    expect(params.has('mode')).toBe(false);
    expect(params.get('document')).toBe(DOC);
    expect(params.has('section')).toBe(false);
    expect(params.get('papers')).toBe('1');
    expect(mergeContentSearch('?q=x', { ...parseSearchParams({}) })).toBe('');
  });

  it('builds the DOC-02 deep link with page, block and the hit revision', () => {
    expect(
      pdfLinkFor('ws 1', { document_id: DOC, revision_id: REV, page: 4, block_id: 'cb/1' }),
    ).toBe(`/workspaces/ws%201/documents/${DOC}?page=4&block=cb%2F1&revision=${REV}`);
  });

  it('keeps a chapter filter only when it is one of the loaded chapters', () => {
    const chapters = [{ id: CHAPTER }];
    expect(reconcileChapter(CHAPTER, chapters)).toBe(CHAPTER);
    expect(reconcileChapter('55555555-5555-4555-8555-555555555555', chapters)).toBeNull();
    expect(reconcileChapter(CHAPTER, null)).toBeNull();
    expect(reconcileChapter(null, chapters)).toBeNull();
  });

  it('sends filters only when set', () => {
    expect(
      searchBody({
        query: 'water',
        mode: 'keyword',
        documentId: null,
        chapterId: null,
        includeQuestionPapers: false,
      }),
    ).toEqual({ query: 'water', mode: 'keyword', limit: 20, include_question_papers: false });
    expect(
      searchBody({
        query: 'water',
        mode: 'hybrid',
        documentId: DOC,
        chapterId: CHAPTER,
        includeQuestionPapers: true,
      }),
    ).toMatchObject({ document_ids: [DOC], chapter_ids: [CHAPTER] });
  });

  it('turns API warnings into Korean guidance, dropping unknown ones', () => {
    expect(
      warningMessages([
        'no published documents in the search scope',
        'no keyword matches',
        'no keyword matches',
        'something internal',
      ]),
    ).toEqual([
      expect.stringContaining('발행된 문서가 없습니다'),
      expect.stringContaining('의미 검색'),
    ]);
    expect(rateLimitMessage(7)).toContain('7초');
  });

  it('SEARCH-01-AC06 maps degraded codes to the non-blocking notice, dropping unknown ones', () => {
    expect(degradedMessages(['dense_unavailable', 'dense_unavailable', 'later_code'])).toEqual([
      '의미 검색을 일시적으로 사용할 수 없어 키워드 결과만 표시합니다.',
    ]);
    expect(degradedMessages([])).toEqual([]);
    // Older API responses without the field.
    expect(degradedMessages(undefined)).toEqual([]);
  });
});

describe('search relay client', () => {
  it('parses Retry-After as seconds or an HTTP date', () => {
    const now = Date.parse('2026-10-18T00:00:00Z');
    expect(parseRetryAfter('12', now)).toBe(12);
    expect(parseRetryAfter('Sun, 18 Oct 2026 00:00:30 GMT', now)).toBe(30);
    expect(parseRetryAfter('Sat, 17 Oct 2026 23:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it('classifies failures', () => {
    expect(classifySearchFailure(401, {})).toBe('unauthenticated');
    expect(classifySearchFailure(404, { detail: 'Workspace not found.' })).toBe('notFound');
    expect(classifySearchFailure(404, { detail: 'Chapter not found.' })).toBe('filterNotFound');
    expect(classifySearchFailure(422, {})).toBe('invalid');
    expect(classifySearchFailure(429, {})).toBe('rateLimited');
    expect(classifySearchFailure(503, {})).toBe('unavailable');
  });

  it('posts to the same-origin relay and reports 429 with its Retry-After', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ title: 'Too Many Requests', status: 429 }), {
          status: 429,
          headers: { 'content-type': 'application/problem+json', 'retry-after': '9' },
        }),
    );
    const client = createSearchClient(fetchImpl as unknown as typeof fetch);
    const error = await client
      .search('ws', {
        query: 'water',
        mode: 'keyword',
        documentId: null,
        chapterId: null,
        includeQuestionPapers: false,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SearchApiError);
    expect(error).toMatchObject({ kind: 'rateLimited', status: 429, retryAfterSeconds: 9 });
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/workspaces/ws/search');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
  });

  it('maps a network failure to a retryable error', async () => {
    const client = createSearchClient((async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch);
    await expect(client.chapters(DOC)).rejects.toMatchObject({ kind: 'network' });
  });
});
