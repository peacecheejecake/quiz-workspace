// @vitest-environment jsdom
// UX7-CACHE (QPLAY-01-AC06): the practice panel's session cache. The pure cache keeps only open,
// answer-free sessions of its own workspace for a bounded time; the panel re-opens an unanswered
// question after recent metadata verification without a new session, never reuses a submitted session, and starts over
// in another workspace.
import './dom-setup';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PracticeSession, SubmitResult } from '../src/lib/questions/practice-actions';
import {
  answerFreeSession,
  PracticeSessionCache,
  PRACTICE_CACHE_TTL_MS,
} from '../src/lib/questions/practice-cache';

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
vi.mock('../src/lib/questions/practice-actions', () => ({
  latestPracticeAction: () => latest(),
  resetPracticeAction: vi.fn(),
  openPracticeSessionAction: (ws: string, q: string, key: string) => open(ws, q, key),
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
}: {
  readonly workspaceId?: string;
  readonly questionId: string | null;
  readonly onGraded?: (id: string, result: 'correct' | 'incorrect' | 'pending') => void;
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
      onViewed={() => undefined}
      onGraded={onGraded}
    />
  );
}

beforeEach(() => {
  open.mockReset();
  submit.mockReset();
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

  it('revalidates cached sessions and restores a newer server result before allowing input', async () => {
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
    expect(await screen.findByText('정답입니다.')).toBeInTheDocument();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('reuses a retry when the latest attempt is the one that preceded it', async () => {
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
    const view = render(<Harness questionId={Q1} />);
    await screen.findByText('정답입니다.');
    await user.click(screen.getByRole('button', { name: /한 번 더 풀기/ }));
    await screen.findByRole('button', { name: '제출' });
    expect(open).toHaveBeenCalledTimes(1);
    view.rerender(<Harness questionId={null} />);
    view.rerender(<Harness questionId={Q1} />);
    await screen.findByRole('button', { name: '제출' });
    expect(open).toHaveBeenCalledTimes(1);
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

  it('does not open a session after a pending lookup is cancelled', async () => {
    let release: () => void = () => undefined;
    latest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              data: {
                session: null,
                previous_revision: false,
                reset_epoch: 0,
                active_revision_id: '77777777-7777-4777-8777-777777777777',
                latest_attempt_id: null,
              },
            });
        }),
    );
    const view = render(<Harness questionId={Q1} />);
    await waitFor(() => expect(latest).toHaveBeenCalledTimes(1));
    view.rerender(<Harness questionId={null} />);
    await act(async () => release());
    expect(open).not.toHaveBeenCalled();
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
