// @vitest-environment jsdom
// CHNOTE-01 정리 노트 (docs/screens/chapter-notes.md): the view model (states, reasons, footnote
// lines, the Markdown subset), the URL helpers (`?panel=chapter-note&chapter=` sharing `chapter`
// with the heatmap filter), the history labels, and the member panel's states against a stubbed
// relay (always-open body, search, footnotes, the covered content under a practice panel, actions
// per role, the feature-off reason, one request per press) and the CHNOTE-02-C05 stacking rule.
import './dom-setup';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@quiz/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventLabel, jobTypeLabel, targetLabel } from '../src/lib/history/model';
import { classifyNoteFailure } from '../src/lib/notes/client';
import {
  batchProgress,
  failureReason,
  footnoteText,
  inlineParts,
  noteHighlightsOf,
  noteView,
  plainItemText,
  plainRangeToRaw,
  rawRangeToPlain,
  versionLabel,
  type ChapterNote,
  type ChapterNoteState,
} from '../src/lib/notes/model';
import { sharedNoteChapterOf, withSharedNote } from '../src/lib/shared/view-state';
import {
  homeOpensBlocked,
  keepNoteChapter,
  noteChapterOf,
  noteCovered,
  openChapterNote,
  parsePanels,
  withChapterNote,
} from '../src/lib/workspaces/home';

let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  usePathname: () => '/workspaces/ws',
  useSearchParams: () => search,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { ChapterNotePanel, notePollDelay } =
  await import('../src/components/questions/notes/chapter-note-panel');

const CH = '11111111-1111-4111-8111-111111111111';
const WS = '44444444-4444-4444-8444-444444444444';
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

  it('maps highlight offsets between raw item text (with delimiters) and the shown text', () => {
    const raw = '**word** tail *em* end';
    const plain = plainItemText(raw);
    expect(plain.text).toBe('word tail em end');
    expect(plain.emphasis).toEqual([
      { start: 0, end: 4, kind: 'strong' },
      { start: 10, end: 12, kind: 'em' },
    ]);
    // Raw 2–6 is "word": shown 0–4, not "rd t".
    expect(rawRangeToPlain(plain, 2, 6)).toEqual({ start: 0, end: 4 });
    // Ends inside delimiters snap to the nearest shown character.
    expect(rawRangeToPlain(plain, 0, 8)).toEqual({ start: 0, end: 4 });
    expect(rawRangeToPlain(plain, 1, 13)).toEqual({ start: 0, end: 9 });
    expect(rawRangeToPlain(plain, 7, 15)).toEqual({ start: 4, end: 10 });
    // Delimiters only: nothing to draw.
    expect(rawRangeToPlain(plain, 6, 8)).toBeNull();
    expect(rawRangeToPlain(plain, 14, 15)).toBeNull();
    // The inverse (creating a highlight from a selection of the shown text).
    expect(plainRangeToRaw(plain, 0, 4)).toEqual({ start: 2, end: 6 });
    expect(plainRangeToRaw(plain, 2, 12)).toEqual({ start: 4, end: 17 });
    expect(plainRangeToRaw(plain, 3, 3)).toBeNull();
    for (const [a, b] of [
      [0, 4],
      [5, 9],
      [10, 12],
      [3, 16],
    ] as const) {
      const r = plainRangeToRaw(plain, a, b);
      expect(r && rawRangeToPlain(plain, r.start, r.end)).toEqual({ start: a, end: b });
    }
    // Drawn note highlights use shown offsets; delimiter-only ones are dropped.
    const h = (id: string, start: number, end: number) =>
      ({
        id,
        color: 'yellow',
        target: { kind: 'note', chapter_note_id: 'n1', note_version: 1 },
        anchor: { block: 's0.i0', start, end },
        anchor_current: null,
      }) as unknown as Parameters<typeof noteHighlightsOf>[0][number];
    const sections = [{ heading: 'h', items: [{ text: raw, footnotes: [1] }] }];
    expect(noteHighlightsOf([h('a', 2, 6), h('b', 6, 8)], 'n1', sections)).toEqual([
      { id: 'a', block: 's0.i0', start: 0, end: 4, color: 'yellow' },
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
    // HILITE-01: the "챕터 없음" group's panel.
    expect(noteChapterOf(new URLSearchParams('?panel=chapter-note&chapter=none'))).toBe('none');
  });

  it('raises an open note panel for any chapter, under another dialog too (Codex P2)', () => {
    const other = '44444444-4444-4444-8444-444444444444';
    expect(openChapterNote('?panel=history', CH)).toEqual({
      search: `?panel=history&panel=chapter-note&chapter=${CH}`,
      raise: false,
    });
    // Chapter A's note is open under 이력; opening chapter B switches it and raises it.
    const under = `?panel=chapter-note&panel=history&chapter=${CH}`;
    const next = openChapterNote(under, other);
    expect(next.raise).toBe(true);
    const params = new URLSearchParams(next.search);
    expect(parsePanels(params)).toEqual(['history', 'chapter-note']);
    expect(noteChapterOf(params)).toBe(other);
    expect(openChapterNote(`?panel=chapter-note&chapter=${CH}`, CH).raise).toBe(true);
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

  it('blocks home-level opens while the note is open; a footnote question stacks over it (CHNOTE-02-C05)', () => {
    const open = new URLSearchParams(`?panel=chapter-note&chapter=${CH}`);
    expect(homeOpensBlocked(open)).toBe(true);
    expect(homeOpensBlocked(new URLSearchParams('?panel=history'))).toBe(false);
    expect(noteCovered(open)).toBe(false);
    // A footnote's question keeps the note and covers it; without the note nothing is covered.
    const stacked = new URLSearchParams(`?panel=chapter-note&chapter=${CH}&question=${Q1}`);
    expect(parsePanels(stacked)).toEqual(['chapter-note']);
    expect(noteCovered(stacked)).toBe(true);
    expect(noteCovered(new URLSearchParams(`?question=${Q1}`))).toBe(false);
    expect(noteCovered(new URLSearchParams(`?panel=chapter-note&chapter=${CH}&practice=new`))).toBe(
      true,
    );
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
      if (url.includes('/my-highlights')) return Response.json({ items: [] });
      if (url.includes('/preview')) {
        return Response.json({
          question_id: Q1,
          number_label: '1장 1번',
          chapter_title: '1장 물의 순환',
          question_type: 'MCQ',
          stem: '첫 문제 발문',
          options: [{ id: 'o1', text: '보기 하나' }],
        });
      }
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
        workspaceId={WS}
        documents={[]}
        open
        onOpenChange={vi.fn()}
        container={document.body}
        chapterId={CH}
        chapterTitle="1장 물의 순환"
        canEdit={canEdit}
        onOpenQuestion={onOpenQuestion}
      />,
      { wrapper: ToastProvider },
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

  it('shows the note body at once with the answers notice; footnotes open the question', async () => {
    responses = [withNote({ stale: true })];
    const onOpenQuestion = vi.fn();
    renderPanel(true, onOpenQuestion);
    const dialog = await screen.findByRole('dialog', { name: '정리 노트' });
    expect(await within(dialog).findByText('AI 생성')).toBeTruthy();
    expect(within(dialog).getByText(/^문제 2개 기준 · /)).toBeTruthy();
    expect(within(dialog).getByText('문제가 바뀌어 최신이 아닙니다')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '다시 만들기' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /정답·해설 포함|펼쳐서 보기/ })).toBeNull();
    expect(
      within(dialog).getByText('이 노트에는 문제의 정답과 해설 내용이 들어 있습니다.'),
    ).toBeTruthy();

    const body = within(dialog).getByRole('group', { name: '정리 노트 본문' });
    expect(within(body).getByRole('heading', { level: 3, name: '물의 순환' })).toBeTruthy();
    expect(within(body).getByText('증발').tagName).toBe('STRONG');
    expect(body.querySelector('b')).toBeNull();
    const refs = within(body).getAllByRole('link', { name: /^각주 \d+$/ });
    expect(refs).toHaveLength(3);
    const list = within(dialog).getByRole('list', { name: '각주' });
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
    const user = userEvent.setup();
    await user.click(link);
    expect(onOpenQuestion).toHaveBeenLastCalledWith(Q1, link);
    // A body footnote number opens its question too; a gone question's number only jumps.
    const [ref1, , ref2] = refs;
    if (!ref1 || !ref2) throw new Error('three footnote numbers');
    expect(ref1.getAttribute('href')).toContain(`question=${Q1}`);
    await user.click(ref1);
    expect(onOpenQuestion).toHaveBeenLastCalledWith(Q1, ref1);
    expect(ref2.getAttribute('href')?.startsWith('#')).toBe(true);
    await user.click(ref2);
    expect(onOpenQuestion).toHaveBeenCalledTimes(2);
  });

  it('finds text in the note with the search row; Escape clears it first', async () => {
    responses = [withNote()];
    renderPanel();
    const dialog = await screen.findByRole('dialog', { name: '정리 노트' });
    const search = await within(dialog).findByRole('searchbox', { name: '노트에서 찾기' });
    const user = userEvent.setup();
    await user.type(search, 'note-');
    await waitFor(() =>
      expect(dialog.querySelectorAll('mark[data-search-result]')).toHaveLength(2),
    );
    expect(within(dialog).getByText('1/2')).toBeTruthy();
    expect(dialog.querySelectorAll('mark[data-current="true"]')).toHaveLength(1);
    await user.keyboard('{Enter}');
    expect(within(dialog).getByText('2/2')).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(within(dialog).getByText('1/2')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect((search as HTMLInputElement).value).toBe('');
    expect(dialog.querySelectorAll('mark[data-search-result]')).toHaveLength(0);
  });

  it('keeps Tab inside the note while a footnote preview is open on its last control', async () => {
    responses = [withNote()];
    renderPanel(false);
    const dialog = await screen.findByRole('dialog', { name: '정리 노트' });
    const list = await within(dialog).findByRole('list', { name: '각주' });
    const last = within(list).getByRole('link');
    const user = userEvent.setup();
    for (let i = 0; i < 20 && document.activeElement !== last; i++) await user.tab();
    expect(last).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toBeTruthy();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);
  });

  it('hides the note content while a practice panel covers it', async () => {
    responses = [withNote()];
    const view = renderPanel();
    const dialog = await screen.findByRole('dialog', { name: '정리 노트' });
    const body = await within(dialog).findByRole('group', { name: '정리 노트 본문' });
    expect(dialog.querySelector('[inert]')).toBeNull();
    search = new URLSearchParams(`panel=chapter-note&chapter=${CH}&question=${Q2}`);
    view.rerender(
      <ChapterNotePanel
        workspaceId={WS}
        documents={[]}
        open
        onOpenChange={vi.fn()}
        container={document.body}
        chapterId={CH}
        canEdit
        onOpenQuestion={vi.fn()}
      />,
    );
    const covered = dialog.querySelector('[inert]');
    expect(covered?.hasAttribute('data-covered')).toBe(true);
    expect(covered?.contains(body)).toBe(true);
    // The header (title, close) stays.
    const close = within(dialog).getByRole('button', { name: '정리 노트 닫기' });
    expect(covered?.contains(close)).toBe(false);
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

  it('lists 내 하이라이트 without an AI note, and alone in the "챕터 없음" panel (HILITE-01)', async () => {
    responses = [state()];
    const view = renderPanel();
    let dialog = await screen.findByRole('dialog', { name: '정리 노트' });
    expect(await within(dialog).findByText('아직 정리 노트가 없습니다.')).toBeTruthy();
    expect(await within(dialog).findByRole('heading', { name: '내 하이라이트 (0)' })).toBeTruthy();
    view.unmount();
    search = new URLSearchParams('panel=chapter-note&chapter=none');
    render(
      <ChapterNotePanel
        workspaceId={WS}
        documents={[]}
        open
        onOpenChange={vi.fn()}
        container={document.body}
        chapterId="none"
        canEdit
        onOpenQuestion={vi.fn()}
      />,
      { wrapper: ToastProvider },
    );
    dialog = await screen.findByRole('dialog', { name: '정리 노트' });
    expect(await within(dialog).findByRole('heading', { name: '내 하이라이트 (0)' })).toBeTruthy();
    expect(within(dialog).getByRole('searchbox', { name: '노트에서 찾기' })).toBeTruthy();
    expect(within(dialog).queryByRole('group', { name: '정리 노트 본문' })).toBeNull();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes(`/api/workspaces/${WS}/my-highlights?chapter=none`),
      ),
    ).toBe(true);
  });

  it('says a chapter without confirmed questions has none, and an unknown one is not found', async () => {
    responses = [state({ confirmed_question_count: 0 })];
    renderPanel();
    const dialog = await screen.findByRole('dialog', { name: '정리 노트' });
    expect(await within(dialog).findByText('이 장에는 확정된 문제가 없습니다.')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: '정리 노트 만들기' })).toBeNull();
  });

  it('keeps polling after a failed re-read and then shows the note (Codex P2)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const running = state({
        generation: { id: 'g5', status: 'running', job_id: null, error_code: null, progress: null },
      });
      let call = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/my-highlights')) return Response.json({ items: [] });
        call += 1;
        if (call === 1) return Response.json(running);
        if (call === 2) return Response.json({ status: 503 }, { status: 503 });
        return Response.json(withNote());
      });
      renderPanel();
      const dialog = await screen.findByRole('dialog', { name: '정리 노트' });
      expect(await within(dialog).findByText('정리 노트를 만드는 중')).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100); // re-read 2 fails: the state stays
      });
      expect(within(dialog).getByText('정리 노트를 만드는 중')).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100); // backed-off re-read 3 succeeds
      });
      await waitFor(() => expect(within(dialog).getByText('AI 생성')).toBeTruthy());
      expect(within(dialog).queryByText(/정리 노트를 만드는 중/)).toBeNull();
      expect(call).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off failed re-reads up to a cap', () => {
    expect([0, 1, 2, 3, 10, 50].map(notePollDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
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
