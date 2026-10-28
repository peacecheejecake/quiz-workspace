// @vitest-environment jsdom
// DOC-01-AC08 `종류 변경` saving (Codex P2): one save per document — the menu is disabled while it
// runs (no second choice), and after any failure the row is re-read from the server before the
// reason is shown (a save whose answer was lost shows the kind the server has).
import './dom-setup';
import { ToastProvider } from '@quiz/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentSummary } from '../src/lib/documents/client-api';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
const { useDocumentLibrary } = await import('../src/components/documents/use-document-library');
const { DocumentsLibrary } = await import('../src/components/documents/documents-library');

const AT = '2026-10-28T00:00:00Z';
const DOC: DocumentSummary = {
  id: 'd1',
  workspace_id: 'ws',
  document_type: 'book',
  kind: 'book',
  kind_source: 'auto',
  title: '수학 책',
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

function Library() {
  const library = useDocumentLibrary({ workspaceId: 'ws', initialDocuments: DOCS, canEdit: true });
  return <DocumentsLibrary workspaceId="ws" library={library} canEdit />;
}

function renderLibrary() {
  render(
    <ToastProvider>
      <Library />
    </ToastProvider>,
  );
  return screen.getByRole('list', { name: '문서 목록' });
}

type Patch = (kind: string) => Promise<Response>;

/** fetch: PATCH answered by `patch`, the list re-read answered with `listed`. */
function stubApi(patch: Patch, listed: () => DocumentSummary) {
  const patches: string[] = [];
  const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const { kind } = JSON.parse(String(init.body)) as { kind: string };
      patches.push(kind);
      return patch(kind);
    }
    return Response.json({ items: [listed()] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return patches;
}

async function pickByKeyboard(trigger: HTMLElement, downs: number) {
  const user = userEvent.setup();
  trigger.focus();
  await user.keyboard('{Enter}');
  await screen.findByRole('menu');
  await user.keyboard(`${'{ArrowDown}'.repeat(downs)}{Enter}`);
  return user;
}

const DOC_B: DocumentSummary = { ...DOC, id: 'd2', title: '과학 책', filename: 'b.pdf' };
const TWO_DOCS = [DOC, DOC_B];

function TwoLibrary() {
  const library = useDocumentLibrary({
    workspaceId: 'ws',
    initialDocuments: TWO_DOCS,
    canEdit: true,
  });
  return <DocumentsLibrary workspaceId="ws" library={library} canEdit />;
}

afterEach(() => vi.unstubAllGlobals());

describe('종류 변경 saving', () => {
  it('disables the menu while the save runs (focus stays on it), then shows the new kind', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const patches = stubApi(
      async (kind) => {
        await held;
        return Response.json({ ...DOC, kind, kind_source: 'user' });
      },
      () => DOC,
    );
    const list = renderLibrary();
    const trigger = within(list).getByRole('button', { name: '수학 책 종류 변경' });
    const user = await pickByKeyboard(trigger, 2); // 교재 → 문제지 → 교재+문제

    await waitFor(() => expect(trigger).toHaveAttribute('aria-disabled', 'true'));
    expect(trigger).toHaveAttribute('aria-busy', 'true');
    expect(within(list).getByText('저장 중')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    // A second choice is impossible: the trigger does not open the menu.
    await user.keyboard('{Enter}');
    await user.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(patches).toEqual(['mixed']);

    release();
    await waitFor(() => expect(within(list).getByText('교재+문제')).toBeInTheDocument());
    expect(trigger).not.toHaveAttribute('aria-disabled');
    expect(within(list).queryByText('저장 중')).toBeNull();
  });

  it('tracks the saving state per row: overlapping saves end independently (Codex P2)', async () => {
    const releases = new Map<string, () => void>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        if (init?.method !== 'PATCH') return Response.json({ items: TWO_DOCS });
        const { kind } = JSON.parse(String(init.body)) as { kind: string };
        const id = path.endsWith('/d1') ? 'd1' : 'd2';
        await new Promise<void>((resolve) => releases.set(id, resolve));
        const base = id === 'd1' ? DOC : DOC_B;
        return Response.json({ ...base, kind, kind_source: 'user' });
      }),
    );
    render(
      <ToastProvider>
        <TwoLibrary />
      </ToastProvider>,
    );
    const list = screen.getByRole('list', { name: '문서 목록' });
    const a = within(list).getByRole('button', { name: '수학 책 종류 변경' });
    const b = within(list).getByRole('button', { name: '과학 책 종류 변경' });
    await pickByKeyboard(a, 2);
    await waitFor(() => expect(a).toHaveAttribute('aria-disabled', 'true'));
    await pickByKeyboard(b, 2);
    await waitFor(() => expect(b).toHaveAttribute('aria-disabled', 'true'));
    expect(a).toHaveAttribute('aria-disabled', 'true'); // starting B leaves A busy

    releases.get('d1')?.();
    await waitFor(() => expect(a).not.toHaveAttribute('aria-disabled'));
    expect(b).toHaveAttribute('aria-disabled', 'true'); // B still waits for its own answer

    releases.get('d2')?.();
    await waitFor(() => expect(b).not.toHaveAttribute('aria-disabled'));
    expect(within(list).getAllByText('교재+문제')).toHaveLength(2);
  });

  it('a network error re-reads the row (the server kind) and shows the generic reason', async () => {
    let saved = false;
    stubApi(
      async () => {
        saved = true; // committed on the server, answer lost
        throw new TypeError('network');
      },
      () => (saved ? { ...DOC, kind: 'mixed', kind_source: 'user' } : DOC),
    );
    const list = renderLibrary();
    await pickByKeyboard(within(list).getByRole('button', { name: '수학 책 종류 변경' }), 2);
    await waitFor(() =>
      expect(within(list).getByRole('alert').textContent).toBe(
        '종류를 바꾸지 못했습니다. 다시 시도하세요.',
      ),
    );
    expect(within(list).getByText('교재+문제')).toBeInTheDocument();
  });

  it('a 409 document-in-use shows its reason and keeps the 교재 badge', async () => {
    stubApi(
      async () =>
        Response.json(
          { type: 'urn:quiz-workspace:problem:document-in-use', status: 409, title: 'Conflict' },
          { status: 409 },
        ),
      () => DOC,
    );
    const list = renderLibrary();
    await pickByKeyboard(within(list).getByRole('button', { name: '수학 책 종류 변경' }), 1); // 문제지
    await waitFor(() =>
      expect(within(list).getByRole('alert').textContent).toBe(
        '이 교재의 챕터나 출처를 쓰는 문제가 있어 문제지로 바꿀 수 없습니다.',
      ),
    );
    expect(within(list).getByText('교재')).toBeInTheDocument();
    expect(within(list).queryByText('문제지')).toBeNull();
  });
});
