// @vitest-environment jsdom
// WS-VIEW-01 SharedWorkspaceView: the `#k=` fragment leaves the address bar before the exchange
// and never reaches a request URL; refusals render only the unavailable notice; the ready view
// has no write/practice controls and a Fork entry only when the link allows it.
import './dom-setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedQuestion, SharedWorkspace } from '../src/lib/shared/client';

vi.mock('next/navigation', () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { SharedWorkspaceView } = await import('../src/components/shared/shared-workspace-view');

const SHARE = '0b6a5c0e-1d2f-4a3b-8c4d-5e6f7a8b9c0d';
const DOC = '1c7b6d1f-2e3a-4b4c-9d5e-6f7a8b9c0d1e';
const Q1 = '2d8c7e2a-3f4b-4c5d-8e6f-7a8b9c0d1e2f';
const SECRET = 'Zq9_'.repeat(11);
const HOME = {
  documentId: null,
  page: null,
  blockId: null,
  forkPanel: false,
  summaryDocumentId: null,
} as const;

const WORKSPACE: SharedWorkspace = {
  workspace: { name: '공유 알고리즘', archived: false },
  allow_fork: false,
  expires_at: null,
  documents: [{ id: DOC, title: '알고리즘 책', document_type: 'book', revision_id: DOC }],
};

const QUESTION = {
  id: Q1,
  question_type: 'MCQ',
  chapter_id: null,
  chapter: null,
  question_number: 1,
  revision: {
    id: Q1,
    version: 1,
    stem: '비는 무엇인가?',
    options: [
      { id: 'o1', text: '가' },
      { id: 'o2', text: '나' },
    ],
    correct_option_ids: ['o2'],
    is_multi_answer: false,
    explanation: '해설 본문',
    accepted_answers: null,
    rubric: null,
  },
  sources: [{ document_id: DOC, page_start: 2, page_end: 2 }],
  updated_at: '2026-10-18T00:00:00Z',
} as unknown as SharedQuestion;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function routes(handlers: Record<string, () => Response | Promise<Response>>) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    const path = url.replace(`/api/shared/${SHARE}`, '').split('?')[0] ?? '';
    // The 정리 노트 card (CHNOTE-01) reads its list on every ready view.
    const handler =
      handlers[path] ?? (path === '/chapter-notes' ? () => json({ items: [] }) : undefined);
    if (!handler) throw new Error(`unexpected request ${path}`);
    return handler();
  });
}

function renderView(overrides: Partial<Parameters<typeof SharedWorkspaceView>[0]> = {}) {
  return render(
    <SharedWorkspaceView
      screenId="WS-VIEW-01"
      forkScreenId="WS-FORK-01"
      shareId={SHARE}
      view={HOME}
      signedIn={false}
      forkLoginHref={`/login?next=${encodeURIComponent(`/share/${SHARE}?panel=fork`)}`}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', `/share/${SHARE}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SharedWorkspaceView', () => {
  it('removes the fragment first, exchanges the secret in the body, then loads', async () => {
    window.history.replaceState(null, '', `/share/${SHARE}#k=${SECRET}`);
    const order: string[] = [];
    let hashAtExchange: string | null = null;
    routes({
      '/sessions': () => {
        hashAtExchange = window.location.hash;
        order.push('exchange');
        return new Response(null, { status: 204 });
      },
      '': () => {
        order.push('workspace');
        return json(WORKSPACE);
      },
      '/questions': () => json({ items: [], next_cursor: null }),
    });

    renderView();
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('공유 알고리즘');
    expect(hashAtExchange).toBe('');
    expect(window.location.hash).toBe('');
    expect(order.slice(0, 2)).toEqual(['exchange', 'workspace']);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain(SECRET);
      if (String(url).endsWith('/sessions')) {
        expect(init?.body).toBe(JSON.stringify({ secret: SECRET }));
      }
    }
    expect(screen.getByText('읽기 전용')).toBeInTheDocument();
  });

  it('shows only the unavailable notice when the link is refused', async () => {
    window.history.replaceState(null, '', `/share/${SHARE}#k=${SECRET}`);
    routes({
      '/sessions': () => json({ type: 'urn:quiz-workspace:problem:share-unavailable' }, 404),
    });
    renderView();
    expect(
      await screen.findByRole('heading', { level: 1, name: /링크를 사용할 수 없습니다/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/읽기 전용/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a missing session without a fragment as unavailable', async () => {
    routes({
      '': () => json({ type: 'urn:quiz-workspace:problem:share-session-required' }, 401),
    });
    renderView();
    expect(
      await screen.findByRole('heading', { name: /링크를 사용할 수 없습니다/ }),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/sessions'))).toBe(false);
  });

  it('renders an invalid share id as unavailable without any request', () => {
    renderView({ shareId: null });
    expect(screen.getByRole('heading', { name: /링크를 사용할 수 없습니다/ })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('previews a question read-only in a non-modal panel', async () => {
    routes({
      '': () => json(WORKSPACE),
      '/questions': () => json({ items: [QUESTION], next_cursor: null }),
    });
    renderView();
    const list = await screen.findByRole('list', { name: /문제/ });
    await userEvent.click(within(list).getByRole('button', { name: /비는 무엇인가/ }));
    const panel = await screen.findByRole('dialog', { name: /문제/ });
    expect(panel).not.toHaveAttribute('aria-modal', 'true');
    expect(panel).toHaveTextContent('나');
    expect(panel).toHaveTextContent('정답');
    expect(panel).toHaveTextContent('해설 본문');
    expect(within(panel).queryAllByRole('radio')).toHaveLength(0);
    expect(
      screen.queryAllByRole('button', { name: /제출|즐겨찾기|다시 풀기|편집|삭제|submit/i }),
    ).toHaveLength(0);
    expect(within(panel).getByRole('link', { name: /알고리즘 책 2쪽/ })).toHaveAttribute(
      'href',
      `/share/${SHARE}?document=${DOC}&page=2`,
    );
  });

  it('offers Fork only when allowed: sign-in for guests, the panel for signed-in users', async () => {
    routes({
      '': () => json(WORKSPACE),
      '/questions': () => json({ items: [], next_cursor: null }),
    });
    const off = renderView();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('link', { name: /^fork/i })).toBeNull();
    off.unmount();

    routes({
      '': () => json({ ...WORKSPACE, allow_fork: true }),
      '/questions': () => json({ items: [], next_cursor: null }),
    });
    const guest = renderView();
    const fork = await screen.findByRole('link', { name: /^fork/i });
    expect(fork).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent(`/share/${SHARE}?panel=fork`)}`,
    );
    expect(screen.getByText(/독립/)).toHaveTextContent(/로그인/);
    guest.unmount();

    renderView({ signedIn: true });
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /^fork/i })).toHaveAttribute(
        'href',
        `/share/${SHARE}?panel=fork`,
      ),
    );
  });

  it('returns focus to the Fork entry when the ?panel=fork dialog closes', async () => {
    routes({
      '': () => json({ ...WORKSPACE, allow_fork: true }),
      '/questions': () => json({ items: [], next_cursor: null }),
    });
    const view = renderView({ signedIn: true, view: { ...HOME, forkPanel: true } });
    expect(await screen.findByRole('dialog', { name: 'Workspace Fork' })).toBeInTheDocument();
    // Navigation-driven close (the URL loses `?panel=fork`).
    view.rerender(
      <SharedWorkspaceView
        screenId="WS-VIEW-01"
        forkScreenId="WS-FORK-01"
        shareId={SHARE}
        view={HOME}
        signedIn
        forkLoginHref="/login"
      />,
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByRole('link', { name: /^fork/i })).toHaveFocus());
  });
  it('lists source-matched chapter notes and opens one read-only, folded (CHNOTE-01)', async () => {
    const CHAPTER = '3e9d8f3b-4a5c-4d6e-9f7a-8b9c0d1e2f3a';
    window.history.replaceState(null, '', `/share/${SHARE}?panel=chapter-note&chapter=${CHAPTER}`);
    routes({
      '': () => json(WORKSPACE),
      '/questions': () => json({ items: [QUESTION], next_cursor: null }),
      '/chapter-notes': () => json({ items: [{ chapter_id: CHAPTER, chapter_title: '1장 비' }] }),
      [`/chapters/${CHAPTER}/note`]: () =>
        json({
          chapter_id: CHAPTER,
          chapter_title: '1장 비',
          created_at: '2026-10-29T06:00:00Z',
          question_count: 1,
          stale: false,
          sections: [{ heading: '비', items: [{ text: 'NOTE-S', footnotes: [1] }] }],
          footnotes: [{ number: 1, question_id: Q1, label: '1장 1번', stem_preview: '비는' }],
        }),
      [`/questions/${Q1}`]: () => json(QUESTION),
    });
    renderView();
    const card = await screen.findByRole('region', { name: '정리 노트' });
    expect(await within(card).findByRole('button', { name: '1장 비' })).toBeInTheDocument();
    const panel = await screen.findByRole('dialog', { name: '정리 노트' });
    expect(await within(panel).findByText('AI 생성')).toBeInTheDocument();
    expect(within(panel).queryByRole('combobox')).toBeNull();
    expect(within(panel).queryByRole('button', { name: /만들기|다시 시도/ })).toBeNull();
    expect(panel).not.toHaveTextContent('NOTE-S');
    await userEvent.click(within(panel).getByRole('button', { name: /^정답·해설 포함/ }));
    expect(panel).toHaveTextContent('NOTE-S');
    await userEvent.click(
      within(within(panel).getByRole('list', { name: '각주' })).getByRole('link'),
    );
    expect(await screen.findByRole('dialog', { name: /1번 문제/ })).toBeInTheDocument();
  });

  it('shows only the missing notice for a note that no longer matches its questions', async () => {
    const CHAPTER = '3e9d8f3b-4a5c-4d6e-9f7a-8b9c0d1e2f3a';
    window.history.replaceState(null, '', `/share/${SHARE}?panel=chapter-note&chapter=${CHAPTER}`);
    routes({
      '': () => json(WORKSPACE),
      '/questions': () => json({ items: [], next_cursor: null }),
      [`/chapters/${CHAPTER}/note`]: () => json({ type: 'about:blank', status: 404 }, 404),
    });
    renderView();
    const panel = await screen.findByRole('dialog', { name: '정리 노트' });
    expect(
      await within(panel).findByText('정리 노트가 갱신 중이거나 없습니다.'),
    ).toBeInTheDocument();
    expect(within(panel).queryByText('AI 생성')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});
