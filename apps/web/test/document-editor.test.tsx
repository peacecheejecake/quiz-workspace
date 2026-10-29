// @vitest-environment jsdom
// DOC-02 editor screen behaviour the E2E specs cannot force: a saved correction stays visible
// (draft revision, publish enabled) when the follow-up text refresh fails, with a retry; a
// refresh overtaken by a newer save never brings back older text; and the `?page=`/`?block=`
// address-bar state follows the selection.
import './dom-setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentBlock, DocumentDetail, RevisionInfo } from '../src/lib/documents/editor-api';

// Stable like Next's app router instance.
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
// PDF.js needs canvas/workers; the viewer is exercised by the E2E specs.
vi.mock('../src/components/documents/editor/pdf-viewer', () => ({
  PdfViewer: ({ page, onPageChange }: { page: number; onPageChange: (p: number) => void }) => (
    <button type="button" onClick={() => onPageChange(page + 1)}>
      next page from {page}
    </button>
  ),
}));

const { DocumentEditor } = await import('../src/components/documents/editor/document-editor');

const DOC = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const V1 = 'a'.repeat(32);
const savedVersion = (n: number) => String(n).padStart(32, 'c');

const revision = (id: string, number: number, draft: boolean): RevisionInfo => ({
  id,
  revision_number: number,
  status: draft ? 'draft' : 'published',
  is_active: !draft,
  parent_revision_id: null,
  published_at: draft ? null : '2026-10-17T00:00:00Z',
  created_at: '2026-10-17T00:00:00Z',
});
const ACTIVE = revision('r1', 1, false);
const DRAFT = revision('r2', 2, true);

const block = (overrides: Partial<ContentBlock> = {}): ContentBlock => ({
  block_id: 'b1',
  caption_block_id: null,
  chapter_id: null,
  edited: false,
  heading_level: null,
  locations: [{ page: 2, bbox: { x0: 1, y0: 1, x1: 2, y1: 2 } }],
  ordinal: 1,
  page: 2,
  table: null,
  text: '',
  type: 'text',
  version: V1,
  ...overrides,
});

const document = {
  id: DOC,
  workspace_id: WS,
  title: '책',
  filename: 'book.pdf',
  status: 'ready',
  active_revision_id: 'r1',
} as unknown as DocumentDetail;

let failBlockReads = false;
let blockReads = 0;
/** While set, block reads answer with the server state of their request time, released later. */
let heldReads: (() => void)[] | null = null;
/** Server side: the revision the text belongs to and each block's text and version. */
let server: { revision: RevisionInfo; texts: Map<string, string>; versions: Map<string, string> };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function serverBlocks(): ContentBlock[] {
  return ['b1', 'b2'].map((id, index) => {
    const version = server.versions.get(id) ?? V1;
    return block({
      block_id: id,
      ordinal: index + 1,
      text: server.texts.get(id) ?? '',
      version,
      edited: version !== V1,
    });
  });
}

function patchBodies(): { text: string; base_version: string }[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String(init?.body)) as { text: string; base_version: string });
}

beforeEach(() => {
  failBlockReads = false;
  blockReads = 0;
  heldReads = null;
  server = {
    revision: ACTIVE,
    texts: new Map([
      ['b1', '원래 문장'],
      ['b2', '둘째 문장'],
    ]),
    versions: new Map([
      ['b1', V1],
      ['b2', V1],
    ]),
  };
  let saves = 0;
  window.history.replaceState(null, '', '/workspaces/ws/documents/doc');
  globalThis.CSS ??= { escape: (v: string) => v } as unknown as typeof CSS;
  Element.prototype.scrollTo ??= () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/outline')) {
        return json({ document_id: DOC, revision: server.revision, items: [] });
      }
      if (url.includes('/revisions')) return json({ document_id: DOC, items: [] });
      if (url.includes('/blocks/') && init?.method === 'PATCH') {
        const id = decodeURIComponent(url.split('/blocks/')[1] ?? '');
        const body = JSON.parse(String(init.body)) as { text: string };
        saves += 1;
        server.revision = DRAFT;
        server.texts.set(id, body.text);
        server.versions.set(id, savedVersion(saves));
        const saved = serverBlocks().find((b) => b.block_id === id);
        return json({ document_id: DOC, revision: DRAFT, block: saved });
      }
      if (url.includes('/blocks')) {
        blockReads += 1;
        if (failBlockReads) return json({ type: 'about:blank', status: 503 }, 503);
        const snapshot = {
          document_id: DOC,
          revision: server.revision,
          items: serverBlocks(),
          next_after: null,
        };
        const queue = heldReads;
        if (queue) {
          return new Promise<Response>((resolve) => queue.push(() => resolve(json(snapshot))));
        }
        return json(snapshot);
      }
      return json({}, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderEditor(
  props: {
    initialBlockId?: string | null;
    initialPage?: number | null;
    pinnedRevisionId?: string | null;
  } = {},
) {
  return render(
    <DocumentEditor
      workspaceId={WS}
      document={document}
      canEdit
      initialPage={props.initialPage ?? null}
      initialBlockId={props.initialBlockId ?? null}
      pinnedRevisionId={props.pinnedRevisionId ?? null}
    />,
  );
}

const editButtons = () => screen.getAllByRole('button', { name: /^편집/ });

async function correct(
  user: ReturnType<typeof userEvent.setup>,
  index: number,
  text: string,
): Promise<void> {
  await user.click(editButtons()[index] as HTMLElement);
  const field = screen.getByRole('textbox', { name: /블록 텍스트/ });
  await user.clear(field);
  await user.type(field, text);
  await user.click(screen.getByRole('button', { name: /^저장/ }));
}

describe('DocumentEditor', () => {
  it('keeps a saved first correction on screen when the text refresh fails, and offers a retry', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findAllByRole('button', { name: /^편집/ });
    failBlockReads = true; // the reload after the new draft fails
    await correct(user, 0, '고친 문장');

    expect(await screen.findByText(/초안에 저장되었지만/)).toBeInTheDocument();
    expect(screen.getByText('고친 문장')).toBeInTheDocument();
    expect(screen.getByText('수정됨')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/초안 저장됨 · 버전 2/);
    expect(screen.getByRole('button', { name: /^발행/ })).toBeEnabled();

    failBlockReads = false;
    const before = blockReads;
    await user.click(screen.getByRole('button', { name: /원문 다시 불러오기/ }));
    await waitFor(() => expect(screen.queryByText(/초안에 저장되었지만/)).not.toBeInTheDocument());
    expect(blockReads).toBeGreaterThan(before);
    expect(screen.getByText('고친 문장')).toBeInTheDocument();
  });

  it('drops a refresh overtaken by a newer save, keeping the newer text and version', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findAllByRole('button', { name: /^편집/ });
    failBlockReads = true;
    await correct(user, 0, '첫 수정');
    await screen.findByText(/초안에 저장되었지만/);

    // The retry's block read is held: its snapshot is the server state before the next save.
    failBlockReads = false;
    const held: (() => void)[] = [];
    heldReads = held;
    await user.click(screen.getByRole('button', { name: /원문 다시 불러오기/ }));
    await waitFor(() => expect(held).toHaveLength(1));

    // Another block is corrected while that refresh is in flight.
    await correct(user, 1, '둘째 수정');
    await screen.findByText('둘째 수정');

    // The stale snapshot arrives late; the re-run refresh answers with the current state.
    heldReads = null;
    held.shift()?.();
    await waitFor(() => expect(screen.queryByText(/초안에 저장되었지만/)).not.toBeInTheDocument());
    expect(screen.getByText('둘째 수정')).toBeInTheDocument();
    expect(screen.queryByText('둘째 문장')).not.toBeInTheDocument();
    expect(screen.getByText('첫 수정')).toBeInTheDocument();

    // The block kept its newer version: the next correction starts from it (no false conflict).
    await correct(user, 1, '셋째 수정');
    await screen.findByText('셋째 수정');
    expect(patchBodies().at(-1)?.base_version).toBe(savedVersion(2));
  });

  it('keeps ?block= in step with the selection and drops it on pure page navigation', async () => {
    const user = userEvent.setup();
    renderEditor({ initialBlockId: 'b1' });
    await screen.findAllByRole('button', { name: /^편집/ });
    await waitFor(() => {
      const params = new URL(window.location.href).searchParams;
      expect(params.get('block')).toBe('b1');
      expect(params.get('page')).toBe('2');
    });

    await user.click(screen.getByRole('button', { name: /next page from 2/ }));
    await waitFor(() => {
      const params = new URL(window.location.href).searchParams;
      expect(params.get('page')).toBe('3');
      expect(params.has('block')).toBe(false);
    });

    await user.click(screen.getAllByRole('button', { name: /원문 위치 보기/ })[1] as HTMLElement);
    await waitFor(() => {
      const params = new URL(window.location.href).searchParams;
      expect(params.get('block')).toBe('b2');
      expect(params.get('page')).toBe('2');
    });
  });

  it('shows a pinned search-hit revision read-only, loaded by its id, with a way to the latest text', async () => {
    renderEditor({ pinnedRevisionId: 'r1', initialBlockId: 'b2' });
    expect(await screen.findByText('둘째 문장')).toBeInTheDocument();
    const reads = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => String(input))
      .filter((url) => url.includes('/blocks') || url.includes('/outline'));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((url) => url.includes('revision=r1'))).toBe(true);
    expect(screen.queryAllByRole('button', { name: /^편집/ })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^발행/ })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(/발행본 · 버전 1 · 검색 결과 기준/);
    expect(screen.getByText(/검색 결과가 나온 발행본을 보고 있습니다/)).toBeInTheDocument();
    const latest = screen.getByRole('link', { name: '최신 원문 보기·교정하기' });
    expect(latest.getAttribute('href')).toMatch(/\/documents\/[^?]+\?page=2&block=b2$/);
  });
  it('DOC-03 전체 복사 of a pinned older revision copies that revision by id, not the published one', async () => {
    // A newer revision r1 is published; the screen shows the search hit's revision r0.
    server.revision = { ...revision('r0', 1, false), is_active: false };
    const base = vi.mocked(fetch).getMockImplementation();
    if (!base) throw new Error('fetch mock missing');
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes('/text?')) {
        return new Response('# 책\n\n원래 문장\n', {
          headers: { 'content-disposition': "attachment; filename*=UTF-8''%EC%B1%85.md" },
        });
      }
      return base(input, init);
    });
    const writeText = vi.fn(async () => undefined);
    const user = userEvent.setup(); // installs its own clipboard: replace it afterwards
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderEditor({ pinnedRevisionId: 'r0' });
    expect(await screen.findByText('둘째 문장')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '텍스트 내보내기' }));
    await user.click(await screen.findByRole('menuitem', { name: '전체 복사' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# 책\n\n원래 문장\n'));
    const exports = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => String(input))
      .filter((url) => url.includes('/text?'));
    expect(exports).toEqual([`/api/documents/${DOC}/text?format=md&revision=r0`]);
  });
});
