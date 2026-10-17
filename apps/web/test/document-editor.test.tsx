// @vitest-environment jsdom
// DOC-02 editor screen behaviour the E2E specs cannot force: a saved correction stays visible
// (draft revision, publish enabled) when the follow-up text refresh fails, with a retry; and the
// `?page=`/`?block=` address-bar state follows the selection.
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
const V2 = 'b'.repeat(32);

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
  text: '원래 문장',
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  failBlockReads = false;
  blockReads = 0;
  window.history.replaceState(null, '', '/workspaces/ws/documents/doc');
  globalThis.CSS ??= { escape: (v: string) => v } as unknown as typeof CSS;
  Element.prototype.scrollTo ??= () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/outline')) return json({ document_id: DOC, revision: ACTIVE, items: [] });
      if (url.includes('/revisions')) return json({ document_id: DOC, items: [] });
      if (url.includes('/blocks/') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { text: string };
        return json({
          document_id: DOC,
          revision: DRAFT,
          block: block({ text: body.text, edited: true, version: V2 }),
        });
      }
      if (url.includes('/blocks')) {
        blockReads += 1;
        if (failBlockReads) return json({ type: 'about:blank', status: 503 }, 503);
        return json({ document_id: DOC, revision: ACTIVE, items: [block()], next_after: null });
      }
      return json({}, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderEditor(props: { initialBlockId?: string | null; initialPage?: number | null } = {}) {
  return render(
    <DocumentEditor
      workspaceId={WS}
      document={document}
      canEdit
      initialPage={props.initialPage ?? null}
      initialBlockId={props.initialBlockId ?? null}
    />,
  );
}

describe('DocumentEditor', () => {
  it('keeps a saved first correction on screen when the text refresh fails, and offers a retry', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(await screen.findByRole('button', { name: /^편집/ }));
    const field = screen.getByRole('textbox', { name: /블록 텍스트/ });
    await user.clear(field);
    await user.type(field, '고친 문장');
    failBlockReads = true; // the reload after the new draft fails
    await user.click(screen.getByRole('button', { name: /^저장/ }));

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
  });

  it('keeps ?block= in step with the selection and drops it on pure page navigation', async () => {
    const user = userEvent.setup();
    renderEditor({ initialBlockId: 'b1' });
    await screen.findByRole('button', { name: /^편집/ });
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

    await user.click(screen.getByRole('button', { name: /원문 위치 보기/ }));
    await waitFor(() => {
      const params = new URL(window.location.href).searchParams;
      expect(params.get('block')).toBe('b1');
      expect(params.get('page')).toBe('2');
    });
  });
});
