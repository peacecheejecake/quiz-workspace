// WS-VIEW-01 browser client and address-bar state: failure classification, the fragment secret
// (read once, never in a URL), block paging over one revision, and the share view's URL params.
import { describe, expect, it, vi } from 'vitest';
import { PdfLoadError } from '../src/lib/documents/pdf-source';
import {
  classifySharedFailure,
  createSharedClient,
  readShareSecret,
  SHARE_SESSION_REQUIRED,
  SHARE_UNAVAILABLE,
  SharedApiError,
  withoutFragment,
} from '../src/lib/shared/client';
import { endsShareView, sharedFailureMessage } from '../src/lib/shared/messages';
import {
  forkPanelHref,
  parseSharedViewParams,
  sharedDocumentHref,
} from '../src/lib/shared/view-state';

const SHARE = '0b6a5c0e-1d2f-4a3b-8c4d-5e6f7a8b9c0d';
const DOC = '1c7b6d1f-2e3a-4b4c-9d5e-6f7a8b9c0d1e';
const SECRET = 'Ab-_'.repeat(11);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function doc(revision: string, blocks: string[], nextAfter: number | null) {
  return {
    id: DOC,
    title: '책',
    document_type: 'book',
    revision_id: revision,
    outline: [],
    blocks: blocks.map((id) => ({ block_id: id })),
    next_after: nextAfter,
  };
}

describe('classifySharedFailure', () => {
  it('maps the share problems and plain statuses', () => {
    expect(classifySharedFailure(404, { type: SHARE_UNAVAILABLE })).toBe('unavailable');
    expect(classifySharedFailure(401, { type: SHARE_SESSION_REQUIRED })).toBe('sessionRequired');
    expect(classifySharedFailure(401, {})).toBe('unavailable');
    expect(classifySharedFailure(404, { type: 'about:blank' })).toBe('notFound');
    expect(classifySharedFailure(429, undefined)).toBe('rateLimited');
    expect(classifySharedFailure(503, undefined)).toBe('failed');
    expect(classifySharedFailure(403, { type: 'about:blank' })).toBe('failed');
  });

  it('ends the view only for unavailable links and missing sessions', () => {
    expect(endsShareView(new SharedApiError('unavailable'))).toBe(true);
    expect(endsShareView(new SharedApiError('sessionRequired'))).toBe(true);
    expect(endsShareView(new SharedApiError('notFound'))).toBe(false);
    expect(endsShareView(new Error('x'))).toBe(false);
  });

  it('has Korean messages without server text', () => {
    expect(sharedFailureMessage(new SharedApiError('rateLimited', 429, 7))).toContain('7초');
    expect(sharedFailureMessage(new SharedApiError('network'))).toContain('네트워크');
    expect(sharedFailureMessage(new Error('internal detail'))).not.toContain('internal');
  });
});

describe('fragment secret', () => {
  it('reads only a base64url `k` from the fragment', () => {
    expect(readShareSecret(`#k=${SECRET}`)).toBe(SECRET);
    expect(readShareSecret(`#x=1&k=${SECRET}`)).toBe(SECRET);
    expect(readShareSecret('')).toBeNull();
    expect(readShareSecret('#k=')).toBeNull();
    expect(readShareSecret('#k=short')).toBeNull();
    expect(readShareSecret(`#k=${SECRET}%3Cscript%3E`)).toBeNull();
    expect(readShareSecret(`k=${SECRET}`)).toBeNull();
  });

  it('rebuilds the address without the fragment', () => {
    expect(withoutFragment({ pathname: `/share/${SHARE}`, search: '?document=x' })).toBe(
      `/share/${SHARE}?document=x`,
    );
  });
});

describe('createSharedClient', () => {
  it('exchanges the secret in a same-origin POST body, never in the URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await createSharedClient(SHARE, fetchImpl).exchange(SECRET);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`/api/shared/${SHARE}/sessions`);
    expect(String(url)).not.toContain(SECRET);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ secret: SECRET }));
    expect(init?.credentials).toBe('same-origin');
    expect(init?.referrerPolicy).toBe('no-referrer');
  });

  it('turns an unusable link into `unavailable` and 429 into a retry delay', async () => {
    const unavailable = createSharedClient(SHARE, async () =>
      json({ type: SHARE_UNAVAILABLE }, 404),
    );
    await expect(unavailable.exchange(SECRET)).rejects.toMatchObject({ kind: 'unavailable' });
    const limited = createSharedClient(SHARE, async () =>
      json({ type: 'about:blank' }, 429, { 'retry-after': '12' }),
    );
    await expect(limited.workspace()).rejects.toMatchObject({
      kind: 'rateLimited',
      retryAfterSeconds: 12,
    });
    const offline = createSharedClient(SHARE, async () => {
      throw new TypeError('fetch failed');
    });
    await expect(offline.workspace()).rejects.toMatchObject({ kind: 'network' });
  });

  it('reads every block page of one revision', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('after=1')) return json(doc('r1', ['b3'], null));
      return json(doc('r1', ['b1', 'b2'], 1));
    });
    const result = await createSharedClient(SHARE, fetchImpl).document(DOC);
    expect(result.blocks.map((b) => b.block_id)).toEqual(['b1', 'b2', 'b3']);
    expect(result.next_after).toBeNull();
    expect(fetchImpl.mock.calls.map(([u]) => u)).toEqual([
      `/api/shared/${SHARE}/documents/${DOC}?limit=500`,
      `/api/shared/${SHARE}/documents/${DOC}?limit=500&after=1`,
    ]);
  });

  it('starts over when a new revision is published between pages, then gives up', async () => {
    let call = 0;
    const pages = [
      doc('r1', ['old1'], 1),
      doc('r2', ['new2'], null),
      doc('r2', ['new1'], 1),
      doc('r2', ['new2'], null),
    ];
    const client = createSharedClient(SHARE, async () => json(pages[call++]));
    const result = await client.document(DOC);
    expect(result.revision_id).toBe('r2');
    expect(result.blocks.map((b) => b.block_id)).toEqual(['new1', 'new2']);

    let flip = 0;
    const unstable = createSharedClient(SHARE, async (input) =>
      json(String(input).includes('after') ? doc(`r${++flip}x`, [], null) : doc('r0', [], 1)),
    );
    await expect(unstable.document(DOC)).rejects.toMatchObject({ kind: 'failed' });
  });

  it('downloads the PDF from the relay with the session cookie and maps failures', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(bytes, { status: 200 }));
    const signal = new AbortController().signal;
    const out = await createSharedClient(SHARE, fetchImpl).pdf(DOC, signal);
    expect([...out]).toEqual([...bytes]);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`/api/shared/${SHARE}/documents/${DOC}/pdf`);
    expect(init?.credentials).toBe('same-origin');

    const missing = createSharedClient(SHARE, async () => json({}, 404));
    await expect(missing.pdf(DOC, signal)).rejects.toBeInstanceOf(PdfLoadError);
  });

  it('searches with the hybrid mode and no filters, and pages questions by cursor', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ items: [], next_cursor: null }));
    const client = createSharedClient(SHARE, fetchImpl);
    await client.search('비');
    await client.questions('abc_-1');
    const [searchUrl, searchInit] = fetchImpl.mock.calls[0] ?? [];
    expect(searchUrl).toBe(`/api/shared/${SHARE}/search`);
    expect(JSON.parse(String(searchInit?.body))).toEqual({
      query: '비',
      mode: 'hybrid',
      limit: 20,
    });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      `/api/shared/${SHARE}/questions?limit=100&cursor=abc_-1`,
    );
  });
});

describe('share view URL state', () => {
  it('accepts only ids and positive page numbers', () => {
    expect(parseSharedViewParams({})).toEqual({
      documentId: null,
      page: null,
      blockId: null,
      forkPanel: false,
    });
    expect(
      parseSharedViewParams({ document: DOC, page: '3', block: 'blk-1', panel: 'fork' }),
    ).toEqual({ documentId: DOC, page: 3, blockId: 'blk-1', forkPanel: true });
    expect(parseSharedViewParams({ document: 'nope', page: '3', block: 'b' })).toEqual({
      documentId: null,
      page: null,
      blockId: null,
      forkPanel: false,
    });
    expect(parseSharedViewParams({ document: DOC, page: '0' }).page).toBeNull();
    expect(parseSharedViewParams({ document: DOC, page: '-1' }).page).toBeNull();
    expect(parseSharedViewParams({ document: DOC, block: '<x>' }).blockId).toBeNull();
    expect(parseSharedViewParams({ panel: 'other' }).forkPanel).toBe(false);
  });

  it('builds document and fork links inside the share route', () => {
    expect(sharedDocumentHref(SHARE, DOC)).toBe(`/share/${SHARE}?document=${DOC}`);
    expect(sharedDocumentHref(SHARE, DOC, { page: 2, blockId: 'b1' })).toBe(
      `/share/${SHARE}?document=${DOC}&page=2&block=b1`,
    );
    expect(forkPanelHref(SHARE)).toBe(`/share/${SHARE}?panel=fork`);
  });
});
