// @vitest-environment jsdom
// CHNOTE-01 정리 노트 (docs/screens/chapter-notes.md): the view model (states, reasons, footnote
// lines, the Markdown subset), the URL helpers (`?panel=chapter-note&chapter=` sharing `chapter`
// with the heatmap filter), the history labels, and the member panel's states against a stubbed
// relay (folded body, footnotes, actions per role, the feature-off reason, one request per press).
import './dom-setup';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventLabel, jobTypeLabel, targetLabel } from '../src/lib/history/model';
import { classifyNoteFailure } from '../src/lib/notes/client';
import {
  batchProgress,
  failureReason,
  footnoteText,
  inlineParts,
  noteView,
  versionLabel,
  type ChapterNote,
  type ChapterNoteState,
} from '../src/lib/notes/model';
import { sharedNoteChapterOf, withSharedNote } from '../src/lib/shared/view-state';
import {
  keepNoteChapter,
  noteChapterOf,
  parsePanels,
  withChapterNote,
} from '../src/lib/workspaces/home';

let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  usePathname: () => '/workspaces/ws',
  useSearchParams: () => search,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { ChapterNotePanel } = await import('../src/components/questions/notes/chapter-note-panel');

const CH = '11111111-1111-4111-8111-111111111111';
const Q1 = '22222222-2222-4222-8222-000000000001';
const Q2 = '22222222-2222-4222-8222-000000000002';

function note(version = 1, overrides: Partial<ChapterNote> = {}): ChapterNote {
  return {
    id: `33333333-3333-4333-8333-00000000000${version}`,
    version,
    created_at: '2026-10-29T06:00:00Z',
    question_count: 2,
    input_fingerprint: 'f',
    question_refs: [],
    usage: null,
    sections: [
      {
        heading: '물의 순환',
        items: [
          { text: '**증발**은 NOTE-A', footnotes: [1] },
          { text: 'NOTE-B <b>raw</b>', footnotes: [1, 2] },
        ],
      },
    ],
    footnotes: [
      { number: 1, question_id: Q1, label: '1장 1번', stem_preview: '첫 문제 발문' },
      { number: 2, question_id: null, label: '1장 2번', stem_preview: null },
    ],
    ...overrides,
  };
}

function state(overrides: Partial<ChapterNoteState> = {}): ChapterNoteState {
  return {
    chapter_id: CH,
    chapter_title: '1장 물의 순환',
    available: true,
    confirmed_question_count: 2,
    generation: null,
    note: null,
    versions: [],
    stale: false,
    ...overrides,
  };
}

const withNote = (extra: Partial<ChapterNoteState> = {}) =>
  state({
    note: note(),
    versions: [
      { version: 1, note_id: 'n1', created_at: '2026-10-29T06:00:00Z', question_count: 2 },
    ],
    generation: {
      id: 'g1',
      status: 'succeeded',
      job_id: null,
      error_code: null,
      progress: null,
    },
    ...extra,
  });

describe('note view model', () => {
  it('maps a state to what the panel offers per role', () => {
    expect(noteView(state(), true)).toMatchObject({ kind: 'empty', canCreate: true });
    expect(noteView(state(), false)).toMatchObject({ kind: 'empty', canCreate: false });
    expect(noteView(state({ confirmed_question_count: 0 }), true)).toMatchObject({
      kind: 'noQuestions',
      canCreate: false,
    });
    expect(noteView(withNote(), true)).toMatchObject({ kind: 'note', canRegenerate: true });
    expect(noteView(withNote(), false)).toMatchObject({ canRegenerate: false });
    const running = withNote({
      generation: { id: 'g2', status: 'running', job_id: null, error_code: null, progress: null },
    });
    expect(noteView(running, true)).toMatchObject({ generating: true, canRegenerate: false });
    const failed = state({
      generation: { id: 'g3', status: 'failed', job_id: null, error_code: 'x', progress: null },
    });
    expect(noteView(failed, true)).toMatchObject({
      failed: true,
      canRetry: true,
      canCreate: false,
    });
    expect(noteView(failed, false)).toMatchObject({ canRetry: false });
    expect(noteView(state({ available: false }), true)).toMatchObject({
      canCreate: true,
      createDisabled: true,
    });
  });

  it('marks an older version and labels versions', () => {
    const old = withNote({
      note: note(1),
      versions: [
        { version: 2, note_id: 'n2', created_at: '2026-10-29T07:00:00Z', question_count: 1 },
        { version: 1, note_id: 'n1', created_at: '2026-10-29T06:00:00Z', question_count: 2 },
      ],
    });
    expect(noteView(old, true).previous).toBe(true);
    const [v2, v1] = old.versions;
    if (!v2 || !v1) throw new Error('two versions');
    expect(versionLabel(v2, true)).toMatch(/^버전 2 · .+ \(최신\)$/);
    expect(versionLabel(v1, false)).toMatch(/^버전 1 · /);
  });

  it('words failures and batch progress as text', () => {
    expect(failureReason('llm_timeout')).toBe(
      'AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.',
    );
    expect(failureReason('note_citation_invalid')).toMatch(/문제 출처를 확인할 수 있는/);
    expect(failureReason('llm_invalid_output')).toBe(
      '정리 노트를 만들지 못했습니다. 다시 시도하세요.',
    );
    expect(
      batchProgress({
        id: 'g',
        status: 'running',
        job_id: null,
        error_code: null,
        progress: { batches_done: 1, batches_total: 3 },
      }),
    ).toBe('1/3 묶음');
    expect(
      batchProgress({
        id: 'g',
        status: 'running',
        job_id: null,
        error_code: null,
        progress: { batches_done: 0, batches_total: 1 },
      }),
    ).toBeNull();
  });

  it('writes footnote lines and never links a gone question', () => {
    const [first, gone] = note().footnotes;
    if (!first || !gone) throw new Error('two footnotes');
    expect(footnoteText(first)).toBe('[^1] 1장 1번 — 첫 문제 발문');
    expect(footnoteText(gone)).toBe('[^2] 1장 2번 — 삭제되었거나 옮긴 문제');
  });

  it('renders emphasis only; HTML, links and images stay text', () => {
    expect(inlineParts('a **b** *c* [d](http://x) <i>e</i> ![f](g)')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'em', text: 'c' },
      { kind: 'text', text: ' [d](http://x) <i>e</i> ![f](g)' },
    ]);
  });

  it('classifies relay problems', () => {
    const p = (slug: string) => ({ type: `urn:quiz-workspace:problem:${slug}` });
    expect(classifyNoteFailure(409, p('note-generation-running'))).toBe('running');
    expect(classifyNoteFailure(409, p('note-generation-disabled'))).toBe('disabled');
    expect(classifyNoteFailure(409, p('no-chapter-questions'))).toBe('noQuestions');
    expect(classifyNoteFailure(403, p('insufficient-role'))).toBe('forbidden');
    expect(classifyNoteFailure(404, undefined)).toBe('notFound');
    expect(classifyNoteFailure(500, undefined)).toBe('failed');
  });

  it('labels chapter note history entries', () => {
    expect(eventLabel('chapter_note.generated')).toBe('정리 노트 생성');
    expect(eventLabel('chapter_note.requested')).toBe('정리 노트 만들기 요청');
    expect(targetLabel('chapter_note', null)).toBe('정리 노트');
    expect(jobTypeLabel('chapter_note.generate')).toBe('정리 노트');
  });
});

describe('note URL state', () => {
  it('opens and closes the panel with its chapter', () => {
    const opened = withChapterNote('?panel=history&status=wrong', CH);
    const params = new URLSearchParams(opened);
    expect(parsePanels(params)).toEqual(['history', 'chapter-note']);
    expect(noteChapterOf(params)).toBe(CH);
    expect(withChapterNote(opened, null)).toBe('?status=wrong&panel=history');
    expect(noteChapterOf(new URLSearchParams(`?chapter=${CH}`))).toBeUndefined();
    expect(noteChapterOf(new URLSearchParams('?panel=chapter-note&chapter=x'))).toBeNull();
  });

  it('keeps the note chapter through other filter changes; a chapter filter closes the note', () => {
    const search = `?panel=chapter-note&chapter=${CH}`;
    // mergeOverviewFilters rewrote `chapter` (deleted, no chapter filter) and added a type.
    expect(keepNoteChapter(search, '?panel=chapter-note&type=MCQ', null)).toBe(
      `?panel=chapter-note&type=MCQ&chapter=${CH}`,
    );
    const other = '44444444-4444-4444-8444-444444444444';
    expect(keepNoteChapter(search, `?panel=chapter-note&chapter=${other}`, other)).toBe(
      `?chapter=${other}`,
    );
    expect(keepNoteChapter('?type=MCQ', '?type=ESSAY', null)).toBe('?type=ESSAY');
  });

  it('opens the share page note panel next to other state', () => {
    const opened = withSharedNote('?document=d', CH);
    expect(sharedNoteChapterOf(new URLSearchParams(opened))).toBe(CH);
    expect(withSharedNote(opened, null)).toBe('?document=d');
    expect(sharedNoteChapterOf(new URLSearchParams('?panel=fork'))).toBeUndefined();
  });
});

describe('ChapterNotePanel', () => {
  let responses: ChapterNoteState[];
  const fetchMock = vi.fn();

  beforeEach(() => {
    search = new URLSearchParams(`panel=chapter-note&chapter=${CH}`);
    responses = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Response.json(
          state({
            generation: {
              id: 'g9',
              status: 'queued',
              job_id: null,
              error_code: null,
              progress: null,
            },
          }),
          { status: 202 },
        );
      }
      const next = responses.length > 1 ? responses.shift() : responses[0];
      return Response.json(next ?? state());
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderPanel(canEdit = true, onOpenQuestion = vi.fn()) {
    return render(
      <ChapterNotePanel
        open
        onOpenChange={vi.fn()}
        container={document.body}
        chapterId={CH}
        chapterTitle="1장 물의 순환"
        canEdit={canEdit}
        onOpenQuestion={onOpenQuestion}
      />,
    );
  }

  it('offers creating to editors with the send notice; one request for a double press', async () => {
    responses = [state()];
    renderPanel();
    const dialog = await screen.findByRole('dialog', { name: '정리 노트' });
    expect(await within(dialog).findByText('아직 정리 노트가 없습니다.')).toBeTruthy();
    expect(within(dialog).getByText(/확정 문제 2개와 해설로/)).toBeTruthy();
    const create = within(dialog).getByRole('button', { name: '정리 노트 만들기' });
    const user = userEvent.setup();
    await user.dblClick(create);
    expect(await within(dialog).findByText(/정리 노트를 만드는 중/)).toBeTruthy();
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    const headers = new Headers(posts[0]?.[1]?.headers);
    expect(headers.get('idempotency-key')).toBeTruthy();
  });

  it('shows the note folded, with footnotes only once expanded', async () => {
    responses = [withNote({ stale: true })];
    const onOpenQuestion = vi.fn();
    renderPanel(true, onOpenQuestion);
    const dialog = await screen.findByRole('dialog', { name: '정리 노트' });
    expect(await within(dialog).findByText('AI 생성')).toBeTruthy();
    expect(within(dialog).getByText(/^문제 2개 기준 · /)).toBeTruthy();
    expect(within(dialog).getByText('문제가 바뀌어 최신이 아닙니다')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '다시 만들기' })).toBeTruthy();
    const disclosure = within(dialog).getByRole('button', {
      name: /^정답·해설 포함 — 펼쳐서 보기/,
    });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    const body = document.getElementById(disclosure.getAttribute('aria-controls') ?? '');
    if (!body) throw new Error('the disclosure controls the body');
    expect(body.hidden).toBe(true);
    expect(dialog.textContent).not.toContain('NOTE-A');

    const user = userEvent.setup();
    await user.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(within(body).getByRole('heading', { level: 3, name: '물의 순환' })).toBeTruthy();
    expect(within(body).getByText('증발').tagName).toBe('STRONG');
    expect(body.querySelector('b')).toBeNull();
    expect(within(body).getAllByRole('link', { name: /^각주 \d+$/ })).toHaveLength(3);
    const list = within(body).getByRole('list', { name: '각주' });
    const lines = within(list).getAllByRole('listitem');
    expect(lines.map((l) => l.textContent)).toEqual([
      '[^1] 1장 1번 — 첫 문제 발문',
      '[^2] 1장 2번 — 삭제되었거나 옮긴 문제',
    ]);
    const [line1, line2] = lines;
    if (!line1 || !line2) throw new Error('two footnote lines');
    expect(within(line2).queryByRole('link')).toBeNull();
    const link = within(line1).getByRole('link');
    expect(link.getAttribute('href')).toContain(`question=${Q1}`);
    await user.click(link);
    expect(onOpenQuestion).toHaveBeenCalledWith(Q1, disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
  });

  it('folds the body when a practice panel opens', async () => {
    responses = [withNote()];
    const view = renderPanel();
    const dialog = await screen.findByRole('dialog', { name: '정리 노트' });
    const disclosure = await within(dialog).findByRole('button', { name: /^정답·해설 포함/ });
    await userEvent.setup().click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    search = new URLSearchParams(`panel=chapter-note&chapter=${CH}&question=${Q2}`);
    view.rerender(
      <ChapterNotePanel
        open
        onOpenChange={vi.fn()}
        container={document.body}
        chapterId={CH}
        canEdit
        onOpenQuestion={vi.fn()}
      />,
    );
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
  });

  it('gives viewers no actions and words a failure as an alert', async () => {
    responses = [
      state({
        generation: {
          id: 'g3',
          status: 'failed',
          job_id: null,
          error_code: 'llm_unavailable',
          progress: null,
        },
      }),
    ];
    renderPanel(false);
    const dialog = await screen.findByRole('dialog', { name: '정리 노트' });
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('정리 노트를 만들지 못했습니다');
    expect(alert.textContent).toContain('AI 서비스에 연결하지 못했습니다');
    expect(within(dialog).queryByRole('button', { name: '다시 시도' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: '정리 노트 만들기' })).toBeNull();
  });

  it('disables creating with the reason when the feature is off', async () => {
    responses = [state({ available: false })];
    renderPanel();
    const dialog = await screen.findByRole('dialog', { name: '정리 노트' });
    const create = await within(dialog).findByRole('button', { name: '정리 노트 만들기' });
    expect(create.getAttribute('aria-disabled')).toBe('true');
    const reason = document.getElementById(create.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toBe('이 환경에서는 AI 정리 노트를 사용할 수 없습니다.');
    await userEvent.setup().click(create);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('says a chapter without confirmed questions has none, and an unknown one is not found', async () => {
    responses = [state({ confirmed_question_count: 0 })];
    renderPanel();
    const dialog = await screen.findByRole('dialog', { name: '정리 노트' });
    expect(await within(dialog).findByText('이 장에는 확정된 문제가 없습니다.')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: '정리 노트 만들기' })).toBeNull();
  });

  it('polls a running generation until it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      responses = [
        state({
          generation: {
            id: 'g4',
            status: 'running',
            job_id: null,
            error_code: null,
            progress: null,
          },
        }),
        withNote(),
      ];
      renderPanel();
      const dialog = await screen.findByRole('dialog', { name: '정리 노트' });
      expect(await within(dialog).findByText('정리 노트를 만드는 중')).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      await waitFor(() => expect(within(dialog).getByText('AI 생성')).toBeTruthy());
      expect(within(dialog).queryByText(/정리 노트를 만드는 중/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
