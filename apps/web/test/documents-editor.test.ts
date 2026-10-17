// DOC-02 logic the E2E specs cannot observe directly: the block correction state machine and its
// version-conflict handling, signed read URL refresh for the PDF download, outline/page mapping,
// the revision status line and the editor's problem classification.
import { describe, expect, it, vi } from 'vitest';
import {
  blockEditReducer,
  hasUnsavedText,
  IDLE,
  type BlockEditState,
} from '../src/lib/documents/block-edit';
import {
  classifyEditorFailure,
  createEditorClient,
  EDITOR_PROBLEMS,
  type ContentBlock,
  type OutlineItem,
  type RevisionHistoryItem,
  type RevisionInfo,
} from '../src/lib/documents/editor-api';
import {
  ancestorsOf,
  blockPage,
  locationsOn,
  parsePageParam,
  sectionOf,
  targetBlockFor,
  visibleOutlineRows,
} from '../src/lib/documents/outline';
import { loadPdfBytes, PdfLoadError, SignedUrlCache } from '../src/lib/documents/pdf-source';
import {
  INDEX_FAILURE_MESSAGE,
  PUBLISH_IDLE,
  resumePublishState,
  revisionStatusText,
} from '../src/lib/documents/publish-state';

const V1 = 'a'.repeat(32);
const V2 = 'b'.repeat(32);

function block(overrides: Partial<ContentBlock> = {}): ContentBlock {
  return {
    block_id: 'b1',
    caption_block_id: null,
    chapter_id: 'c1',
    edited: false,
    heading_level: null,
    locations: [{ page: 2, bbox: { x0: 10, y0: 20, x1: 100, y1: 40 } }],
    ordinal: 1,
    page: 2,
    table: null,
    text: 'original text',
    type: 'text',
    version: V1,
    ...overrides,
  };
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
}

function editing(state: BlockEditState) {
  if (state.phase === 'idle') throw new Error('expected an edit in progress');
  return state;
}

describe('blockEditReducer', () => {
  it('runs start → change → save → saved back to idle', () => {
    let state = blockEditReducer(IDLE, { type: 'start', block: block() });
    expect(editing(state)).toMatchObject({
      phase: 'editing',
      text: 'original text',
      baseVersion: V1,
    });
    state = blockEditReducer(state, { type: 'change', text: 'fixed text' });
    expect(hasUnsavedText(state)).toBe(true);
    state = blockEditReducer(state, { type: 'save' });
    expect(editing(state)).toMatchObject({ phase: 'saving', text: 'fixed text', baseVersion: V1 });
    state = blockEditReducer(state, { type: 'saved', blockId: 'b1' });
    expect(state).toBe(IDLE);
  });

  it('treats saving an unchanged text as a cancel (no draft is created)', () => {
    const state = blockEditReducer(blockEditReducer(IDLE, { type: 'start', block: block() }), {
      type: 'save',
    });
    expect(state).toBe(IDLE);
  });

  it('keeps the typed text and shows the failure when a save fails', () => {
    let state = blockEditReducer(IDLE, { type: 'start', block: block() });
    state = blockEditReducer(state, { type: 'change', text: 'fixed' });
    state = blockEditReducer(state, { type: 'save' });
    state = blockEditReducer(state, {
      type: 'failed',
      blockId: 'b1',
      failure: { kind: 'network', message: 'offline' },
    });
    expect(editing(state)).toMatchObject({
      phase: 'editing',
      text: 'fixed',
      baseVersion: V1,
      failure: { kind: 'network' },
    });
  });

  it('on an edit conflict moves base_version to the server version and shows the server text', () => {
    let state = blockEditReducer(IDLE, { type: 'start', block: block() });
    state = blockEditReducer(state, { type: 'change', text: 'my fix' });
    state = blockEditReducer(state, { type: 'save' });
    state = blockEditReducer(state, {
      type: 'conflict',
      blockId: 'b1',
      failure: { kind: 'conflict', message: 'changed elsewhere' },
      latest: { text: 'their fix', version: V2 },
    });
    const conflicted = editing(state);
    expect(conflicted).toMatchObject({
      phase: 'editing',
      text: 'my fix',
      original: 'their fix',
      baseVersion: V2,
      conflict: { serverText: 'their fix' },
    });
    // Saving again sends the server's version, so the deliberate overwrite is accepted.
    const resaved = editing(blockEditReducer(state, { type: 'save' }));
    expect(resaved).toMatchObject({ phase: 'saving', baseVersion: V2, text: 'my fix' });
  });

  it('keeps the old base_version when the conflicting block could not be reloaded', () => {
    let state = blockEditReducer(IDLE, { type: 'start', block: block() });
    state = blockEditReducer(state, { type: 'change', text: 'my fix' });
    state = blockEditReducer(state, { type: 'save' });
    state = blockEditReducer(state, {
      type: 'conflict',
      blockId: 'b1',
      failure: { kind: 'conflict', message: 'changed' },
      latest: null,
    });
    expect(editing(state)).toMatchObject({ baseVersion: V1, failure: { kind: 'conflict' } });
    expect((state as { conflict?: unknown }).conflict).toBeUndefined();
  });

  it('ignores answers for another block and edits while saving', () => {
    let state = blockEditReducer(IDLE, { type: 'start', block: block() });
    state = blockEditReducer(state, { type: 'change', text: 'x' });
    state = blockEditReducer(state, { type: 'save' });
    expect(blockEditReducer(state, { type: 'saved', blockId: 'other' })).toBe(state);
    expect(blockEditReducer(state, { type: 'change', text: 'y' })).toBe(state);
    expect(blockEditReducer(state, { type: 'cancel' })).toBe(state);
    expect(blockEditReducer(state, { type: 'start', block: block({ block_id: 'b2' }) })).toBe(
      state,
    );
  });
});

describe('SignedUrlCache + loadPdfBytes', () => {
  const now = Date.parse('2026-10-17T00:00:00Z');
  const signed = (url: string, inSeconds: number) => ({
    url,
    expires_at: new Date(now + inSeconds * 1000).toISOString(),
  });
  const pdf = (status = 200) =>
    new Response(status === 200 ? new Uint8Array([37, 80, 68, 70]) : '{"error":"InvalidJWT"}', {
      status,
      headers: { 'content-type': status === 200 ? 'application/pdf' : 'application/json' },
    });

  it('reuses a fresh URL and asks for a new one shortly before it expires', async () => {
    let clock = now;
    const source = vi
      .fn()
      .mockResolvedValueOnce(signed('https://storage/one', 300))
      .mockResolvedValueOnce(signed('https://storage/two', 600));
    const cache = new SignedUrlCache(source, () => clock);
    expect(await cache.get()).toBe('https://storage/one');
    clock = now + 200_000;
    expect(await cache.get()).toBe('https://storage/one');
    clock = now + 290_000; // within the refresh margin
    expect(await cache.get()).toBe('https://storage/two');
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('downloads the whole file with one plain GET', async () => {
    const cache = new SignedUrlCache(
      async () => signed('https://storage/a', 300),
      () => now,
    );
    const fetchImpl = vi.fn(async () => pdf());
    const bytes = await loadPdfBytes(cache, { fetchImpl });
    expect(Array.from(bytes)).toEqual([37, 80, 68, 70]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has('range')).toBe(false);
    expect(init.credentials).toBe('omit');
  });

  it('gets a new signed URL and retries once when Storage refuses an expired one', async () => {
    const source = vi
      .fn()
      .mockResolvedValueOnce(signed('https://storage/old', 300))
      .mockResolvedValueOnce(signed('https://storage/new', 300));
    const cache = new SignedUrlCache(source, () => now);
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/old') ? pdf(400) : pdf(),
    );
    await expect(loadPdfBytes(cache, { fetchImpl })).resolves.toHaveLength(4);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://storage/old',
      'https://storage/new',
    ]);
  });

  it('gives up with "expired" after the refreshed URL is refused too', async () => {
    let n = 0;
    const cache = new SignedUrlCache(
      async () => signed(`https://storage/${n++}`, 300),
      () => now,
    );
    const error = await loadPdfBytes(cache, { fetchImpl: async () => pdf(403) }).catch((e) => e);
    expect(error).toBeInstanceOf(PdfLoadError);
    expect((error as PdfLoadError).kind).toBe('expired');
  });

  it('reports a network failure without retrying with a new URL', async () => {
    const source = vi.fn(async () => signed('https://storage/a', 300));
    const cache = new SignedUrlCache(source, () => now);
    const error = await loadPdfBytes(cache, {
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    }).catch((e) => e);
    expect((error as PdfLoadError).kind).toBe('network');
    expect(source).toHaveBeenCalledTimes(1);
  });
});

describe('outline helpers', () => {
  const outline: OutlineItem[] = [
    {
      id: 'ch1',
      section_key: 'ch1',
      title: '1장',
      level: 1,
      page: 2,
      block_id: 'ch1-h',
      children: [
        {
          id: 'ch1-s1',
          section_key: 'ch1-s1',
          title: '1.1',
          level: 2,
          page: 2,
          block_id: 'ch1-s1-h',
          children: [],
        },
        {
          id: 'ch1-s2',
          section_key: 'ch1-s2',
          title: '1.2',
          level: 2,
          page: 3,
          block_id: 'ch1-s2-h',
          children: [],
        },
      ],
    },
    {
      id: 'ch2',
      section_key: 'ch2',
      title: '2장',
      level: 1,
      page: 4,
      block_id: 'ch2-h',
      children: [],
    },
  ];
  const blocks = [
    block({ block_id: 'ch1-h', chapter_id: 'ch1', type: 'heading' }),
    block({ block_id: 'ch1-p1', chapter_id: 'ch1' }),
    block({ block_id: 'ch1-s1-h', chapter_id: 'ch1-s1', type: 'heading' }),
    block({ block_id: 'ch1-s2-h', chapter_id: 'ch1-s2', type: 'heading', page: 3, locations: [] }),
    block({
      block_id: 'ch1-s2-p1',
      chapter_id: 'ch1-s2',
      page: 3,
      locations: [
        { page: 3, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
        { page: 4, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
      ],
    }),
  ];

  it('flattens the tree with levels and positions and hides collapsed children', () => {
    const rows = visibleOutlineRows(outline, new Set());
    expect(rows.map((r) => [r.node.id, r.depth, r.position, r.siblings])).toEqual([
      ['ch1', 1, 1, 2],
      ['ch1-s1', 2, 1, 2],
      ['ch1-s2', 2, 2, 2],
      ['ch2', 1, 2, 2],
    ]);
    expect(visibleOutlineRows(outline, new Set(['ch1'])).map((r) => r.node.id)).toEqual([
      'ch1',
      'ch2',
    ]);
  });

  it('leads a section to its first body block, else its heading, else its page', () => {
    expect(targetBlockFor(at(outline, 0), blocks)?.block_id).toBe('ch1-p1');
    expect(targetBlockFor(at(at(outline, 0).children, 0), blocks)?.block_id).toBe('ch1-s1-h');
    expect(targetBlockFor(at(at(outline, 0).children, 1), blocks)?.block_id).toBe('ch1-s2-p1');
    expect(targetBlockFor({ id: 'gone', block_id: null, page: 3 }, blocks)?.block_id).toBe(
      'ch1-s2-h',
    );
  });

  it('maps blocks to pages, sections and highlight locations', () => {
    const crossPage = at(blocks, 4);
    expect(blockPage(crossPage)).toBe(3);
    expect(blockPage(at(blocks, 3))).toBe(3); // no locations: the block's page
    expect(locationsOn(crossPage, 4)).toHaveLength(1);
    expect(locationsOn(crossPage, 5)).toHaveLength(0);
    expect(sectionOf(crossPage, outline)).toBe('ch1-s2');
    expect(ancestorsOf('ch1-s2', outline)).toEqual(['ch1']);
  });

  it('parses only positive integer ?page= values', () => {
    expect(parsePageParam('4')).toBe(4);
    expect(parsePageParam(['2', '9'])).toBe(2);
    for (const bad of [undefined, '', '0', '-1', '2.5', 'x', '1e3']) {
      expect(parsePageParam(bad)).toBeNull();
    }
  });
});

describe('revision status and publish resume', () => {
  const revision = (overrides: Partial<RevisionInfo> = {}): RevisionInfo => ({
    id: 'r2',
    revision_number: 2,
    status: 'draft',
    parent_revision_id: 'r1',
    is_active: false,
    published_at: null,
    created_at: '2026-10-17T00:00:00Z',
    ...overrides,
  });

  it('tells readers, drafts, saves, indexing, success and failure apart in words', () => {
    const base = { canEdit: true, justSaved: false, publish: PUBLISH_IDLE };
    expect(revisionStatusText({ ...base, revision: revision() })).toMatch(/^초안 · 버전 2/);
    expect(revisionStatusText({ ...base, justSaved: true, revision: revision() })).toMatch(
      /초안 저장됨/,
    );
    const published = revision({ status: 'published', is_active: true });
    expect(revisionStatusText({ ...base, revision: published })).toMatch(/^발행됨/);
    expect(revisionStatusText({ ...base, canEdit: false, revision: published })).toMatch(
      /읽기 전용/,
    );
    expect(
      revisionStatusText({ ...base, revision: revision(), publish: { phase: 'requesting' } }),
    ).not.toMatch(/발행(됨| 완료)/);
    expect(
      revisionStatusText({
        ...base,
        revision: revision(),
        publish: { phase: 'indexing', jobId: 'j', job: null },
      }),
    ).not.toMatch(/발행(됨| 완료)/);
    expect(
      revisionStatusText({
        ...base,
        revision: published,
        publish: { phase: 'succeeded', revisionNumber: 2 },
      }),
    ).toMatch(/발행 완료/);
    expect(
      revisionStatusText({
        ...base,
        revision: revision(),
        publish: { phase: 'failed', reason: 'indexing', message: 'x' },
      }),
    ).toMatch(/색인 실패/);
  });

  it('resumes a running publish of the draft and re-offers a failed one after a reload', () => {
    const history = (status: string): RevisionHistoryItem[] => [
      { ...revision(), job: { id: 'job-2', status } },
      {
        ...revision({ id: 'r1', revision_number: 1, status: 'published', is_active: true }),
        job: { id: 'job-1', status: 'succeeded' },
      },
    ];
    expect(resumePublishState(history('running'), INDEX_FAILURE_MESSAGE)).toEqual({
      phase: 'indexing',
      jobId: 'job-2',
      job: null,
    });
    expect(resumePublishState(history('failed'), INDEX_FAILURE_MESSAGE)).toMatchObject({
      phase: 'failed',
      reason: 'indexing',
    });
    expect(resumePublishState(history('succeeded'), INDEX_FAILURE_MESSAGE)).toBe(PUBLISH_IDLE);
    // The first parse (nothing published yet) is not a correction publish.
    expect(resumePublishState([{ ...revision(), job: { id: 'j', status: 'running' } }], 'x')).toBe(
      PUBLISH_IDLE,
    );
  });
});

describe('editor API client', () => {
  it('classifies the DOC-02 problem types', () => {
    const problem = (type: string) => ({ type, title: 't', status: 409 });
    expect(classifyEditorFailure(409, problem(EDITOR_PROBLEMS.editConflict))).toBe('conflict');
    expect(classifyEditorFailure(409, problem(EDITOR_PROBLEMS.publishInProgress))).toBe(
      'publishInProgress',
    );
    expect(classifyEditorFailure(409, problem(EDITOR_PROBLEMS.nothingToPublish))).toBe(
      'nothingToPublish',
    );
    expect(classifyEditorFailure(409, problem(EDITOR_PROBLEMS.documentNotReady))).toBe('notReady');
    expect(classifyEditorFailure(403, problem(EDITOR_PROBLEMS.workspaceArchived))).toBe('archived');
    expect(classifyEditorFailure(403, problem(EDITOR_PROBLEMS.insufficientRole))).toBe('forbidden');
    expect(classifyEditorFailure(401, undefined)).toBe('unauthenticated');
    expect(classifyEditorFailure(502, undefined)).toBe('unavailable');
  });

  it('sends corrections with base_version and publishes with an Idempotency-Key via the BFF', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true }, { status: String(url).endsWith('/publish') ? 202 : 200 });
    });
    const client = createEditorClient(fetchImpl as typeof fetch);
    await client.correctBlock('doc-1', 'ch1/p 1', 'new text', V1);
    await client.publish('doc-1', 'rev-2', 'key-123');
    expect(calls[0]?.url).toBe('/api/documents/doc-1/blocks/ch1%2Fp%201');
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ text: 'new text', base_version: V1 });
    expect(calls[1]?.url).toBe('/api/documents/doc-1/publish');
    expect(new Headers(calls[1]?.init.headers).get('idempotency-key')).toBe('key-123');
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ revision_id: 'rev-2' });
  });

  it('loads every block page and retries when the revision moved in between', async () => {
    const rev = (id: string) => ({ id, revision_number: 1 });
    let outlineRevision = 'r1';
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/outline')) {
        const answer = { items: [], revision: rev(outlineRevision) };
        outlineRevision = 'r2';
        return Response.json(answer);
      }
      const after = new URL(path, 'http://x').searchParams.get('after');
      const revisionId = 'r2';
      return Response.json(
        after === null
          ? { items: [block({ block_id: 'a' })], next_after: 1, revision: rev(revisionId) }
          : { items: [block({ block_id: 'b' })], next_after: null, revision: rev(revisionId) },
      );
    });
    const client = createEditorClient(fetchImpl as typeof fetch);
    const content = await client.loadContent('doc-1', 'latest');
    expect(content.blocks.map((b) => b.block_id)).toEqual(['a', 'b']);
    expect(content.revision?.id).toBe('r2');
    // First outline answered r1 while blocks were r2: loaded a second time.
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).includes('/outline'))).toHaveLength(2);
  });
});
