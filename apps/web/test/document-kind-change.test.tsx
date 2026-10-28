// @vitest-environment jsdom
// DOC-01-AC08 `종류 변경` while an earlier change is still being saved (Codex P2): the picks are
// serialised per document and the last one wins — 교재 → 교재+문제 (slow) → 교재 ends as 교재.
import './dom-setup';
import { ToastProvider } from '@quiz/ui';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentSummary } from '../src/lib/documents/client-api';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));
const { useDocumentLibrary } = await import('../src/components/documents/use-document-library');

const AT = '2026-10-28T00:00:00Z';
const DOC: DocumentSummary = {
  id: 'd1',
  workspace_id: 'ws',
  document_type: 'book',
  kind: 'book',
  kind_source: 'auto',
  title: '교재',
  filename: 'book.pdf',
  size_bytes: 1,
  sha256: 'a'.repeat(64),
  status: 'ready',
  active_revision_id: 'rev',
  last_error: null,
  created_at: AT,
  updated_at: AT,
  latest_import_id: null,
};

/** One array for every render: a new one would be a fresher server list (the hook resyncs). */
const DOCS = [DOC];

afterEach(() => vi.unstubAllGlobals());

describe('useDocumentLibrary changeKind', () => {
  it('sends a pick made during a slow save after it, so the last pick wins', async () => {
    const sent: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        const { kind } = JSON.parse(String(init.body)) as { kind: DocumentSummary['kind'] };
        sent.push(String(kind));
        if (sent.length === 1) await firstHeld;
        return Response.json({ ...DOC, kind, kind_source: 'user' });
      }),
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ToastProvider>{children}</ToastProvider>
    );
    const { result } = renderHook(
      () => useDocumentLibrary({ workspaceId: 'ws', initialDocuments: DOCS, canEdit: true }),
      { wrapper },
    );
    const row = () => {
      const found = result.current.rows[0];
      if (!found) throw new Error('no row');
      return found;
    };

    let first!: Promise<void>;
    act(() => {
      first = result.current.changeKind(row(), 'mixed');
    });
    await waitFor(() => expect(result.current.changingKind).toBe('d1'));
    // The row still says 교재 (the first save has not answered): pick 교재 again.
    expect(row().kind).toBe('book');
    let second!: Promise<void>;
    act(() => {
      second = result.current.changeKind(row(), 'book');
    });
    await act(async () => {
      releaseFirst();
      await Promise.all([first, second]);
    });

    expect(sent).toEqual(['mixed', 'book']);
    expect(row().kind).toBe('book');
    expect(result.current.changingKind).toBeNull();
    expect(result.current.kindFailures).toEqual({});
  });

  it('after a refused pick it still sends the newer pick and shows no reason (409 then 교재+문제)', async () => {
    const sent: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        if (!init?.method) return Response.json({ items: DOCS }); // the list refresh
        const { kind } = JSON.parse(String(init.body)) as { kind: DocumentSummary['kind'] };
        sent.push(String(kind));
        if (sent.length === 1) {
          await firstHeld;
          return Response.json(
            { type: 'urn:quiz-workspace:problem:document-in-use', status: 409, title: 'Conflict' },
            { status: 409 },
          );
        }
        return Response.json({ ...DOC, kind, kind_source: 'user' });
      }),
    );
    const { result } = renderHook(
      () => useDocumentLibrary({ workspaceId: 'ws', initialDocuments: DOCS, canEdit: true }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <ToastProvider>{children}</ToastProvider>
        ),
      },
    );
    const row = () => {
      const found = result.current.rows[0];
      if (!found) throw new Error('no row');
      return found;
    };
    let first!: Promise<void>;
    act(() => {
      first = result.current.changeKind(row(), 'question_paper');
    });
    await waitFor(() => expect(result.current.changingKind).toBe('d1'));
    let second!: Promise<void>;
    act(() => {
      second = result.current.changeKind(row(), 'mixed');
    });
    await act(async () => {
      releaseFirst();
      await Promise.all([first, second]);
    });
    expect(sent).toEqual(['question_paper', 'mixed']);
    expect(row().kind).toBe('mixed');
    expect(result.current.kindFailures).toEqual({});
    expect(result.current.changingKind).toBeNull();
  });

  it('shows the reason when the refused pick is the last one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init?: RequestInit) =>
        init?.method
          ? Response.json(
              {
                type: 'urn:quiz-workspace:problem:document-in-use',
                status: 409,
                title: 'Conflict',
              },
              { status: 409 },
            )
          : Response.json({ items: DOCS }),
      ),
    );
    const { result } = renderHook(
      () => useDocumentLibrary({ workspaceId: 'ws', initialDocuments: DOCS, canEdit: true }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <ToastProvider>{children}</ToastProvider>
        ),
      },
    );
    const row = result.current.rows[0];
    if (!row) throw new Error('no row');
    await act(() => result.current.changeKind(row, 'question_paper'));
    expect(result.current.kindFailures).toEqual({
      d1: '이 교재의 챕터나 출처를 쓰는 문제가 있어 문제지로 바꿀 수 없습니다.',
    });
    expect(result.current.rows[0]?.kind).toBe('book');
  });

  it('sends nothing when the pick is the kind the PDF already has', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(
      () => useDocumentLibrary({ workspaceId: 'ws', initialDocuments: DOCS, canEdit: true }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <ToastProvider>{children}</ToastProvider>
        ),
      },
    );
    const row = result.current.rows[0];
    if (!row) throw new Error('no row');
    await act(() => result.current.changeKind(row, 'book'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
