// @vitest-environment jsdom
// UX7-CACHE (QPLAY-01-AC06): the practice panel's session cache. The pure cache keeps only open,
// answer-free sessions of its own workspace for a bounded time; the panel re-opens an unanswered
// question after recent metadata verification without a new session, never reuses a submitted session, and starts over
// in another workspace.
import './dom-setup';
import { act, screen, waitFor, within } from '@testing-library/react';
import { renderWithToasts as render } from './render-with-toasts';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invalidation } from '../src/components/questions/viewer/practice-viewer';
import type { PracticeSession, SubmitResult } from '../src/lib/questions/practice-actions';
import {
  answerFreeSession,
  OpeningViews,
  PracticeSessionCache,
  PRACTICE_CACHE_TTL_MS,
} from '../src/lib/questions/practice-cache';
import { publishPracticeReset } from '../src/lib/questions/practice-reset-events';

const WS = '55555555-5555-4555-8555-555555555555';
const WS2 = '55555555-5555-4555-8555-000000000002';
const Q1 = '22222222-2222-4222-8222-000000000001';
const Q2 = '22222222-2222-4222-8222-000000000002';

let sessionSeq = 0;
function session(questionId: string, overrides: Partial<PracticeSession> = {}): PracticeSession {
  sessionSeq += 1;
  return {
    id: `99999999-9999-4999-8999-${String(sessionSeq).padStart(12, '0')}`,
    workspace_id: WS,
    question_id: questionId,
    question_revision_id: '77777777-7777-4777-8777-777777777777',
    question_number: 1,
    question_type: 'MCQ',
    chapter_id: null,
    stem: `stem of ${questionId}`,
    is_multi_answer: false,
    displayed_option_ids: ['o2', 'o1'],
    options: [
      { id: 'o2', text: '보기 나' },
      { id: 'o1', text: '보기 가' },
    ],
    state: 'open',
    opened_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

describe('OpeningViews', () => {
  it('UX12-SOLVEDOPEN-AC09 keeps one view per question until it is dropped or cleared', () => {
    const views = new OpeningViews<string>();
    views.put(Q1.toUpperCase(), 'first', views.token(Q1));
    views.put(Q2, 'second', views.token(Q2));
    expect(views.get(Q1)).toBe('first');
    views.drop(Q1);
    expect(views.get(Q1)).toBeUndefined();
    views.clear();
    expect(views.get(Q2)).toBeUndefined();
  });

  it('UX12-SOLVEDOPEN-AC09 a write begun before a clear or a drop lands nowhere', () => {
    const views = new OpeningViews<string>();
    const beforeClear = views.token(Q1);
    views.clear();
    views.put(Q1, 'late', beforeClear);
    expect(views.get(Q1)).toBeUndefined();

    const beforeDrop = views.token(Q2);
    const other = views.token(Q1);
    views.drop(Q2);
    views.put(Q2, 'late', beforeDrop);
    expect(views.get(Q2)).toBeUndefined();
    views.put(Q1, 'kept', other);
    expect(views.get(Q1)).toBe('kept');
    views.put(Q2, 'new', views.token(Q2));
    expect(views.get(Q2)).toBe('new');
  });
});

describe('PracticeSessionCache', () => {
  it('returns an open session of its workspace by question id (any case)', () => {
    const cache = new PracticeSessionCache(WS);
    const s = session(Q1);
    cache.put(s);
    expect(cache.get(Q1)).toEqual(s);
    expect(cache.get(Q1.toUpperCase())).toEqual(s);
    expect(cache.get(Q2)).toBeNull();
    expect(cache.get(null)).toBeNull();
  });

  it('ignores sessions of another workspace and sessions that are no longer open', () => {
    const cache = new PracticeSessionCache(WS);
    cache.put(session(Q1, { workspace_id: WS2 }));
    cache.put(session(Q2, { state: 'graded' }));
    expect(cache.size).toBe(0);
    cache.put(session(Q1));
    cache.put(session(Q1, { state: 'pending_grade' }));
    expect(cache.get(Q1)).toBeNull();
  });

  it('never stores fields outside the answer-free PracticeSession shape', () => {
    const cache = new PracticeSessionCache(WS);
    const leaky = {
      ...session(Q1),
      correct_option_ids: ['o1'],
      explanation: '해설',
      rubric: '기준',
      accepted_answers: ['가'],
      options: [{ id: 'o1', text: '보기 가', is_correct: true }],
    } as unknown as PracticeSession;
    cache.put(leaky);
    const stored = cache.get(Q1);
    expect(JSON.stringify(stored)).not.toMatch(/correct|explanation|rubric|accepted/);
    expect(stored).toEqual(answerFreeSession(leaky));
    expect(stored?.options).toEqual([{ id: 'o1', text: '보기 가' }]);
  });

  it('never takes back a dropped session (a late duplicate open response), within bounds', () => {
    let now = 0;
    const cache = new PracticeSessionCache(WS, { now: () => now, maxEntries: 2 });
    const s1 = session(Q1);
    cache.put(s1);
    cache.dropSession(s1.id);
    cache.put(s1);
    expect(cache.get(Q1)).toBeNull();
    // A new session of the same question is fine.
    cache.put(session(Q1));
    expect(cache.get(Q1)).not.toBeNull();
    // The dropped ids are bounded by the same cap and TTL as the entries.
    const s2 = session(Q2);
    const s3 = session(Q2);
    cache.dropSession(s2.id);
    cache.dropSession(s3.id);
    cache.put(s1);
    expect(cache.get(Q1)?.id).toBe(s1.id);
    cache.dropSession(s1.id);
    now += PRACTICE_CACHE_TTL_MS;
    cache.put(s1);
    expect(cache.get(Q1)?.id).toBe(s1.id);
  });

  it('expires entries after the TTL', () => {
    let now = 1_000;
    const cache = new PracticeSessionCache(WS, { now: () => now });
    cache.put(session(Q1));
    now += PRACTICE_CACHE_TTL_MS - 1;
    expect(cache.get(Q1)).not.toBeNull();
    now += 1;
    expect(cache.get(Q1)).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('drops a session whose submission started, and evicts the oldest beyond the bound', () => {
    const cache = new PracticeSessionCache(WS, { maxEntries: 2 });
    const s1 = session(Q1);
    cache.put(s1);
    cache.dropSession(s1.id);
    expect(cache.get(Q1)).toBeNull();
    const q3 = '22222222-2222-4222-8222-000000000003';
    cache.put(session(Q1));
    cache.put(session(Q2));
    cache.put(session(q3));
    expect(cache.get(Q1)).toBeNull();
    expect(cache.get(Q2)).not.toBeNull();
    expect(cache.get(q3)).not.toBeNull();
  });
});

const latest = vi.fn<() => Promise<unknown>>();
const open = vi.fn<(ws: string, q: string, key: string) => Promise<unknown>>();
const submit = vi.fn<(ws: string, sessionId: string, answer: unknown) => Promise<unknown>>();
const reset = vi.fn();
const recordReturn = vi.fn();
vi.mock('../src/components/practice-return/practice-return-provider', () => ({
  useOptionalPracticeReturn: () => ({ recordActivity: recordReturn }),
}));
vi.mock('../src/lib/questions/practice-open-client', async () => {
  const { fakePracticeOpen, fakePracticeReveal } = await import('./practice-open-fake');
  return {
    openQuestionPractice: fakePracticeOpen({
      latest: () => latest(),
      open: (ws: string, q: string, key: string) => open(ws, q, key),
    }),
    revealQuestionPractice: fakePracticeReveal({ latest: () => latest() }),
  };
});
vi.mock('../src/lib/questions/practice-actions', () => ({
  resetPracticeAction: reset,
  submitPracticeAction: (ws: string, s: string, a: unknown) => submit(ws, s, a),
  selfGradePracticeAction: vi.fn(),
}));

const { QuestionViewer } = await import('../src/components/questions/viewer/question-viewer');

function question(id: string, n: number) {
  return {
    id,
    title: `1장 ${n}번 문제`,
    chapterTitle: '1장',
    questionType: 'MCQ' as const,
    preview: `preview ${n}`,
    isFavorite: false,
    needsRetry: false,
    lastGradedResult: null,
    isPendingGrading: false,
  };
}

function Harness({
  workspaceId = WS,
  questionId,
  onGraded,
  onViewed = () => undefined,
}: {
  readonly workspaceId?: string;
  readonly questionId: string | null;
  readonly onGraded?: (id: string, result: 'correct' | 'incorrect' | 'pending') => void;
  readonly onViewed?: (id: string) => void;
}) {
  const q = questionId === Q1 ? question(Q1, 1) : questionId === Q2 ? question(Q2, 2) : null;
  return (
    <QuestionViewer
      mode="practice"
      workspaceId={workspaceId}
      question={q}
      readOnly={false}
      onClose={() => undefined}
      onFlagsChange={() => undefined}
      onViewed={onViewed}
      onGraded={onGraded}
    />
  );
}

beforeEach(() => {
  open.mockReset();
  submit.mockReset();
  reset.mockReset();
  recordReturn.mockReset();
  latest.mockReset();
  latest.mockResolvedValue({
    ok: true,
    data: {
      session: null,
      previous_revision: false,
      reset_epoch: 0,
      active_revision_id: '77777777-7777-4777-8777-777777777777',
      latest_attempt_id: null,
    },
  });
  open.mockImplementation(async (ws, q) => ({
    ok: true,
    data: session(q, { workspace_id: ws, stem: `stem of ${q}` }),
  }));
});

describe('QuestionViewer practice session cache', () => {
  it('UX11-RETURN-AC02 records the valid standalone question on entry', async () => {
    render(<Harness questionId={Q1} />);
    await screen.findByText(`stem of ${Q1}`);
    expect(recordReturn).toHaveBeenCalledWith({
      kind: 'question',
      workspaceId: WS,
      questionId: Q1,
    });
  });

  it('re-opens a viewed unanswered question after metadata verification without a new session', async () => {
    const view = render(<Harness questionId={Q1} />);
    expect(await screen.findByText(`stem of ${Q1}`)).toBeInTheDocument();
    view.rerender(<Harness questionId={Q2} />);
    expect(await screen.findByText(`stem of ${Q2}`)).toBeInTheDocument();
    view.rerender(<Harness questionId={null} />);
    view.rerender(<Harness questionId={Q1} />);
    // Recent metadata is checked before reusing either answer-free session.
    expect(await screen.findByText(`stem of ${Q1}`)).toBeInTheDocument();
    view.rerender(<Harness questionId={Q2} />);
    expect(await screen.findByText(`stem of ${Q2}`)).toBeInTheDocument();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('UX12-SOLVEDOPEN-AC01 a result made elsewhere opens a new session, not the result', async () => {
    const view = render(<Harness questionId={Q1} />);
    await screen.findByRole('radio', { name: '보기 가' });
    view.rerender(<Harness questionId={null} />);
    let release: (value: unknown) => void = () => undefined;
    latest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    view.rerender(<Harness questionId={Q1} />);
    expect(screen.queryByRole('button', { name: '제출' })).not.toBeInTheDocument();
    const result = {
      attempt_id: 'attempt',
      practice_session_id: session(Q1).id,
      question_revision_id: session(Q1).question_revision_id,
      result: 'correct',
      correct_option_ids: ['o1'],
      accepted_answers: null,
      explanation: null,
      rubric: null,
    };
    await act(async () =>
      release({
        ok: true,
        data: {
          reset_epoch: 0,
          previous_revision: false,
          active_revision_id: session(Q1).question_revision_id,
          latest_attempt_id: 'attempt',
          submitted_answer: { selected_option_ids: ['o1'] },
          session: { ...session(Q1), state: 'graded', outcome: result },
        },
      }),
    );
    expect(await screen.findByRole('button', { name: '해설 보기' })).toBeInTheDocument();
    expect(screen.queryByText('정답입니다.')).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('UX11-RETURN-AC01 opens a fresh session without resetting history and reuses that retry', async () => {
    const user = userEvent.setup();
    const previous = session(Q1);
    const result = {
      attempt_id: 'old-attempt',
      practice_session_id: previous.id,
      question_revision_id: previous.question_revision_id,
      result: 'correct',
      correct_option_ids: ['o1'],
      accepted_answers: null,
      explanation: null,
      rubric: null,
    };
    latest.mockResolvedValue({
      ok: true,
      data: {
        reset_epoch: 0,
        previous_revision: false,
        active_revision_id: previous.question_revision_id,
        latest_attempt_id: 'old-attempt',
        submitted_answer: { selected_option_ids: ['o1'] },
        session: { ...previous, state: 'graded', outcome: result },
      },
    });
    open.mockImplementationOnce(async (ws, q) => ({
      ok: true,
      data: session(q, { id: 'first-session', workspace_id: ws }),
    }));
    open.mockImplementationOnce(async (ws, q) => ({
      ok: true,
      data: session(q, { id: 'second-session', workspace_id: ws }),
    }));
    const view = render(<Harness questionId={Q1} />);
    await user.click(await screen.findByRole('button', { name: '해설 보기' }));
    await screen.findByText('정답입니다.');
    await user.click(screen.getByRole('button', { name: /^다시 풀기$/ }));
    await screen.findByRole('button', { name: '제출' });
    expect(open).toHaveBeenCalledTimes(2);
    expect(reset).not.toHaveBeenCalled();
    view.rerender(<Harness questionId={null} />);
    view.rerender(<Harness questionId={Q1} />);
    await screen.findByRole('button', { name: '제출' });
    expect(open).toHaveBeenCalledTimes(2);
    expect(reset).not.toHaveBeenCalled();
  });

  it('reuses a current revision session when only an older revision was submitted', async () => {
    latest.mockResolvedValue({
      ok: true,
      data: {
        reset_epoch: 0,
        previous_revision: true,
        active_revision_id: '77777777-7777-4777-8777-777777777777',
        latest_attempt_id: 'old-attempt',
        submitted_answer: null,
        session: null,
      },
    });
    const view = render(<Harness questionId={Q1} />);
    await screen.findByRole('button', { name: '제출' });
    view.rerender(<Harness questionId={null} />);
    view.rerender(<Harness questionId={Q1} />);
    await screen.findByRole('button', { name: '제출' });
    expect(screen.getByRole('link', { name: /이전 풀이 이력 보기/ })).toBeInTheDocument();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('opens a new session after a submission instead of reusing the submitted one', async () => {
    const user = userEvent.setup();
    const result: SubmitResult = {
      attempt_id: '88888888-8888-4888-8888-888888888888',
      practice_session_id: '',
      question_revision_id: '77777777-7777-4777-8777-777777777777',
      result: 'correct',
      correct_option_ids: ['o1'],
      accepted_answers: null,
      rubric: null,
      explanation: 'EXPLANATION-SECRET',
      my_state: null,
    } as unknown as SubmitResult;
    submit.mockImplementation(async (_ws, sessionId) => ({
      ok: true,
      data: { ...result, practice_session_id: sessionId },
    }));
    const view = render(<Harness questionId={Q1} />);
    await user.click(await screen.findByRole('radio', { name: '보기 가' }));
    await user.click(screen.getByRole('button', { name: '제출' }));
    expect(await screen.findByText('EXPLANATION-SECRET')).toBeInTheDocument();
    const submitted = submit.mock.calls[0]?.[1];

    view.rerender(<Harness questionId={null} />);
    view.rerender(<Harness questionId={Q1} />);
    expect(screen.queryByText('EXPLANATION-SECRET')).not.toBeInTheDocument();
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    await user.click(await screen.findByRole('radio', { name: '보기 가' }));
    await user.click(screen.getByRole('button', { name: '제출' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1]?.[1]).not.toBe(submitted);
  });

  it('reports a completed submission after navigating to another question', async () => {
    const user = userEvent.setup();
    const onGraded = vi.fn();
    let release: (value: unknown) => void = () => undefined;
    submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const view = render(<Harness questionId={Q1} onGraded={onGraded} />);
    await user.click(await screen.findByRole('radio', { name: '보기 가' }));
    await user.click(screen.getByRole('button', { name: '제출' }));
    view.rerender(<Harness questionId={Q2} onGraded={onGraded} />);
    await act(async () => release({ ok: true, data: { result: 'correct' } }));
    expect(onGraded).toHaveBeenCalledWith(Q1, 'correct');
  });

  it('does not reuse a session whose submission failed or is still in flight', async () => {
    const user = userEvent.setup();
    let release: (v: unknown) => void = () => undefined;
    submit.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const view = render(<Harness questionId={Q1} />);
    await user.click(await screen.findByRole('radio', { name: '보기 가' }));
    await user.click(screen.getByRole('button', { name: '제출' }));
    view.rerender(<Harness questionId={null} />);
    view.rerender(<Harness questionId={Q1} />);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    await act(async () => {
      release({ ok: false, kind: 'alreadySubmitted', message: '이미 제출한 풀이입니다.' });
    });
  });

  it('ignores an opening that returns after the panel moved on', async () => {
    const onViewed = vi.fn();
    let release: () => void = () => undefined;
    latest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, data: {} });
        }),
    );
    const view = render(<Harness questionId={Q1} onViewed={onViewed} />);
    await waitFor(() => expect(latest).toHaveBeenCalledTimes(1));
    view.rerender(<Harness questionId={null} onViewed={onViewed} />);
    await act(async () => release());
    expect(open).toHaveBeenCalledTimes(1);
    expect(onViewed).not.toHaveBeenCalled();
  });

  it('UX10-QVIEW-AC04 a reset closing the panel does not open the question again', async () => {
    function Resetting() {
      const [questionId, setQuestionId] = useState<string | null>(Q1);
      const [invalidated, setInvalidated] = useState<Invalidation | null>(null);
      const q = questionId ? question(Q1, 1) : null;
      return (
        <QuestionViewer
          mode="practice"
          workspaceId={WS}
          question={q}
          readOnly={false}
          invalidated={invalidated}
          onReset={(id) => setInvalidated({ questionId: id, seq: 1 })}
          onClose={() => setTimeout(() => setQuestionId(null), 0)}
          onFlagsChange={() => undefined}
          onViewed={() => undefined}
        />
      );
    }
    render(<Resetting />);
    await screen.findByRole('button', { name: '제출' });
    expect(open).toHaveBeenCalledTimes(1);
    act(() => publishPracticeReset(WS, { [Q1]: 1 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('records a view only for a session the server opened', async () => {
    const onViewed = vi.fn();
    const view = render(<Harness questionId={Q1} onViewed={onViewed} />);
    await screen.findByRole('button', { name: '제출' });
    expect(onViewed).toHaveBeenCalledTimes(1);
    view.rerender(<Harness questionId={null} onViewed={onViewed} />);
    view.rerender(<Harness questionId={Q1} onViewed={onViewed} />);
    await screen.findByRole('button', { name: '제출' });
    expect(onViewed).toHaveBeenCalledTimes(1);
  });

  it('a late duplicate open response never restores a session whose submission started', async () => {
    const user = userEvent.setup();
    const s1 = session(Q1);
    let releaseLate: () => void = () => undefined;
    open
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseLate = () => resolve({ ok: true, data: s1 }))),
      )
      .mockImplementationOnce(async () => ({ ok: true, data: s1 }));
    submit.mockImplementation(async () => ({
      ok: false,
      kind: 'unavailable',
      message: '일시적인 오류',
    }));
    const view = render(<Harness questionId={Q1} />);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    view.rerender(<Harness questionId={null} />);
    view.rerender(<Harness questionId={Q1} />);
    await user.click(await screen.findByRole('radio', { name: '보기 가' }));
    expect(open).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: '제출' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await act(async () => releaseLate());
    view.rerender(<Harness questionId={null} />);
    view.rerender(<Harness questionId={Q1} />);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(3));
  });

  it('starts over in another workspace', async () => {
    const view = render(<Harness questionId={Q1} />);
    expect(await screen.findByText(`stem of ${Q1}`)).toBeInTheDocument();
    view.rerender(<Harness questionId={null} />);
    view.rerender(<Harness workspaceId={WS2} questionId={null} />);
    view.rerender(<Harness workspaceId={WS2} questionId={Q1} />);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(open.mock.calls[1]?.[0]).toBe(WS2);
  });

  it('re-opens with an empty answer even when the session is reused', async () => {
    const user = userEvent.setup();
    const view = render(<Harness questionId={Q1} />);
    await user.click(await screen.findByRole('radio', { name: '보기 가' }));
    expect(screen.getByRole('radio', { name: '보기 가' })).toBeChecked();
    view.rerender(<Harness questionId={null} />);
    view.rerender(<Harness questionId={Q1} />);
    expect(await screen.findByRole('radio', { name: '보기 가' })).not.toBeChecked();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('UX12-SOLVEDOPEN the question first, 해설 보기 on request', () => {
  const previous = session(Q1);
  const outcome = {
    attempt_id: 'old-attempt',
    practice_session_id: previous.id,
    question_revision_id: previous.question_revision_id,
    result: 'correct',
    correct_option_ids: ['o1'],
    accepted_answers: null,
    explanation: '이전 해설',
    rubric: null,
  };
  const solved = {
    ok: true,
    data: {
      reset_epoch: 0,
      previous_revision: false,
      active_revision_id: previous.question_revision_id,
      latest_attempt_id: 'old-attempt',
      submitted_answer: { selected_option_ids: ['o1'] },
      session: { ...previous, state: 'graded', outcome },
    },
  };
  /** The next check waits for `release`; a navigation asks only after its pause (`called`). */
  function holdLatest() {
    let release: (value: unknown) => void = () => undefined;
    const called = new Promise<void>((started) => {
      latest.mockImplementationOnce(() => {
        started();
        return new Promise((resolve) => (release = resolve));
      });
    });
    return { called, release: (value: unknown) => release(value) };
  }

  let sessions = 0;
  beforeEach(() => {
    sessions = 0;
    open.mockImplementation(async (ws, q) => ({
      ok: true,
      data: session(q, { id: `opened-${(sessions += 1)}`, workspace_id: ws }),
    }));
  });

  it('AC01 a solved question opens to be answered, with 해설 보기', async () => {
    latest.mockResolvedValue(solved);
    render(<Harness questionId={Q1} />);
    expect(await screen.findByRole('button', { name: '해설 보기' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '제출' })).toBeInTheDocument();
    expect(screen.queryByText('정답입니다.')).toBeNull();
    expect(screen.queryByText('이전 해설')).toBeNull();
  });

  it('AC02 a question never solved has no 해설 보기', async () => {
    render(<Harness questionId={Q1} />);
    await screen.findByRole('button', { name: '제출' });
    expect(screen.queryByRole('button', { name: '해설 보기' })).toBeNull();
  });

  it('AC02 a question solved only on an older revision has no 해설 보기', async () => {
    latest.mockResolvedValue({
      ok: true,
      data: { ...solved.data, previous_revision: true, session: null },
    });
    render(<Harness questionId={Q1} />);
    await screen.findByRole('button', { name: '제출' });
    expect(screen.queryByRole('button', { name: '해설 보기' })).toBeNull();
  });

  it('AC03 해설 보기 shows the earlier result in place of the form', async () => {
    const user = userEvent.setup();
    latest.mockResolvedValue(solved);
    render(<Harness questionId={Q1} />);
    await user.click(await screen.findByRole('button', { name: '해설 보기' }));
    expect(await screen.findByText('이전 해설')).toBeInTheDocument();
    expect(screen.getByText('정답입니다.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '제출' })).toBeNull();
    expect(screen.queryByRole('button', { name: '해설 보기' })).toBeNull();
    expect(screen.getByRole('button', { name: /^다시 풀기$/ })).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('AC04 an answer being written waits for a confirm and is never submitted', async () => {
    const user = userEvent.setup();
    latest.mockResolvedValue(solved);
    render(<Harness questionId={Q1} />);
    await user.click(await screen.findByRole('radio', { name: '보기 가' }));
    await user.click(screen.getByRole('button', { name: '해설 보기' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: '취소' }));
    expect(screen.getByRole('radio', { name: '보기 가' })).toBeChecked();
    expect(screen.queryByText('이전 해설')).toBeNull();

    await user.click(screen.getByRole('button', { name: '해설 보기' }));
    const again = await screen.findByRole('alertdialog');
    await user.click(within(again).getByRole('button', { name: '해설 보기' }));
    expect(await screen.findByText('이전 해설')).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it('AC07 a revealed question comes back with its result until the panel closes', async () => {
    const user = userEvent.setup();
    latest.mockResolvedValue(solved);
    const view = render(<Harness questionId={Q1} />);
    await user.click(await screen.findByRole('button', { name: '해설 보기' }));
    await screen.findByText('이전 해설');

    view.rerender(<Harness questionId={Q2} />);
    await screen.findByRole('button', { name: '해설 보기' });
    expect(open).toHaveBeenCalledTimes(2);
    view.rerender(<Harness questionId={Q1} />);
    expect(await screen.findByText('이전 해설')).toBeInTheDocument();
    expect(open).toHaveBeenCalledTimes(2);

    view.rerender(<Harness questionId={null} />);
    view.rerender(<Harness questionId={Q1} />);
    await screen.findByRole('button', { name: '해설 보기' });
    expect(screen.queryByText('이전 해설')).toBeNull();
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('AC07 a question submitted here comes back with its result; 다시 풀기 ends that', async () => {
    const user = userEvent.setup();
    submit.mockResolvedValue({ ok: true, data: outcome });
    const view = render(<Harness questionId={Q1} />);
    await user.click(await screen.findByRole('radio', { name: '보기 가' }));
    await user.click(screen.getByRole('button', { name: '제출' }));
    await screen.findByText('이전 해설');
    latest.mockResolvedValue(solved);

    view.rerender(<Harness questionId={Q2} />);
    await screen.findByText(/보기 가/);
    view.rerender(<Harness questionId={Q1} />);
    await screen.findByText('이전 해설');

    await user.click(screen.getByRole('button', { name: /^다시 풀기$/ }));
    await screen.findByRole('button', { name: '제출' });
    view.rerender(<Harness questionId={Q2} />);
    await screen.findByRole('button', { name: '해설 보기' });
    view.rerender(<Harness questionId={Q1} />);
    await screen.findByRole('button', { name: '제출' });
    expect(screen.queryByText('이전 해설')).toBeNull();
  });

  it('AC09 going back shows what this opening loaded at once, with no loading text', async () => {
    const view = render(<Harness questionId={Q1} />);
    await screen.findByRole('radio', { name: '보기 가' });
    view.rerender(<Harness questionId={Q2} />);
    await screen.findByText(`stem of ${Q2}`);

    const held = holdLatest();
    view.rerender(<Harness questionId={Q1} />);
    expect(screen.getByRole('radio', { name: '보기 가' })).toBeInTheDocument();
    expect(screen.queryByText(/문제를 불러오는 중/)).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    await act(async () => {
      await held.called;
      held.release({
        ok: true,
        data: {
          session: null,
          previous_revision: false,
          reset_epoch: 0,
          active_revision_id: previous.question_revision_id,
          latest_attempt_id: null,
        },
      });
    });
    expect(screen.getByRole('radio', { name: '보기 가' })).toBeInTheDocument();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('AC09 nothing can be submitted until the kept session is confirmed', async () => {
    const user = userEvent.setup();
    const view = render(<Harness questionId={Q1} />);
    await screen.findByRole('radio', { name: '보기 가' });
    view.rerender(<Harness questionId={Q2} />);
    await screen.findByText(`stem of ${Q2}`);
    const held = holdLatest();
    view.rerender(<Harness questionId={Q1} />);
    await user.click(screen.getByRole('radio', { name: '보기 가' }));
    expect(screen.getByRole('button', { name: '제출' })).toBeDisabled();
    await act(async () => {
      await held.called;
      held.release({
        ok: true,
        data: {
          session: null,
          previous_revision: false,
          reset_epoch: 0,
          active_revision_id: previous.question_revision_id,
          latest_attempt_id: null,
        },
      });
    });
    expect(screen.getByRole('button', { name: '제출' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: '보기 가' })).toBeChecked();
  });

  it('AC09 a kept result comes back without any request', async () => {
    const user = userEvent.setup();
    latest.mockResolvedValue(solved);
    const view = render(<Harness questionId={Q1} />);
    await user.click(await screen.findByRole('button', { name: '해설 보기' }));
    await screen.findByText('이전 해설');
    view.rerender(<Harness questionId={Q2} />);
    await screen.findByRole('button', { name: '해설 보기' });
    latest.mockClear();
    view.rerender(<Harness questionId={Q1} />);
    expect(screen.getByText('이전 해설')).toBeInTheDocument();
    expect(screen.queryByText(/문제를 불러오는 중/)).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(latest).not.toHaveBeenCalled();
  });

  it('AC09 a submission that lands after the panel closed cannot fill the next opening', async () => {
    const user = userEvent.setup();
    let finish: (value: unknown) => void = () => undefined;
    submit.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const view = render(<Harness questionId={Q1} />);
    await user.click(await screen.findByRole('radio', { name: '보기 가' }));
    await user.click(screen.getByRole('button', { name: '제출' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    view.rerender(<Harness questionId={null} />);
    await act(async () => finish({ ok: true, data: outcome }));

    latest.mockResolvedValue(solved);
    view.rerender(<Harness questionId={Q1} />);
    await screen.findByRole('button', { name: '해설 보기' });
    expect(screen.queryByText('이전 해설')).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('AC09 a reveal that fails after the quiet check returned leaves the session usable', async () => {
    const user = userEvent.setup();
    latest.mockResolvedValue(solved);
    const view = render(<Harness questionId={Q1} />);
    await screen.findByRole('button', { name: '해설 보기' });
    view.rerender(<Harness questionId={Q2} />);
    await screen.findByText(`stem of ${Q2}`);

    const check = holdLatest();
    const failing = holdLatest();
    view.rerender(<Harness questionId={Q1} />);
    await act(async () => {
      await check.called;
    });
    await user.click(screen.getByRole('button', { name: '해설 보기' }));
    await act(async () => {
      await failing.called;
    });
    await act(async () => check.release(solved));
    expect(screen.getByRole('button', { name: '제출' })).toBeDisabled();
    await act(async () =>
      failing.release({ ok: false, kind: 'unavailable', message: '일시적인 오류입니다.' }),
    );

    await screen.findByText('일시적인 오류입니다.');
    await user.click(screen.getByRole('radio', { name: '보기 가' }));
    expect(screen.getByRole('button', { name: '제출' })).toBeEnabled();
    expect(screen.queryByText('이전 해설')).toBeNull();
  });

  it('AC09 해설 보기 pressed during the quiet check keeps the result', async () => {
    const user = userEvent.setup();
    latest.mockResolvedValue(solved);
    const view = render(<Harness questionId={Q1} />);
    await screen.findByRole('button', { name: '해설 보기' });
    view.rerender(<Harness questionId={Q2} />);
    await screen.findByText(`stem of ${Q2}`);
    const held = holdLatest();
    view.rerender(<Harness questionId={Q1} />);
    await act(async () => {
      await held.called;
    });
    await user.click(screen.getByRole('button', { name: '해설 보기' }));
    await screen.findByText('이전 해설');
    await act(async () => held.release(solved));
    expect(screen.getByText('이전 해설')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '제출' })).toBeNull();
  });
});
