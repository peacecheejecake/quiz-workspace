// @vitest-environment jsdom
// QVIEW-W review follow-ups: the sequence viewer's async edges, driven by controllable promises.
// A run is never finished under a submission in flight; a run created after the panel closed (or
// was reopened) never navigates; an ambiguous creation failure keeps its idempotency key so a
// retry recovers the same run; a failed session opening and a submission whose response was lost
// both have a way back.
import './dom-setup';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PracticeSession, SubmitResult } from '../src/lib/questions/practice-actions';
import type { PracticeRun, RunItem, RunUrlState } from '../src/lib/questions/practice-runs';
import type { RunActionResult } from '../src/lib/questions/practice-run-problems';
import type { RunClient } from '../src/components/questions/viewer/question-viewer';
import {
  publishPracticeReset,
  rememberPracticeEpoch,
} from '../src/lib/questions/practice-reset-events';

vi.mock('../src/lib/questions/practice-actions', () => ({
  openPracticeSessionAction: vi.fn(),
  submitPracticeAction: vi.fn(),
  selfGradePracticeAction: vi.fn(),
  setMyStateAction: vi.fn(),
  lookupOverviewQuestionAction: vi.fn(),
}));
vi.mock('../src/lib/questions/actions', () => ({
  getQuestionAction: vi.fn(),
  getQuestionRevisionAction: vi.fn(),
}));

const { QuestionViewer, bankRunClient } =
  await import('../src/components/questions/viewer/question-viewer');
const actions = await import('../src/lib/questions/practice-actions');

const WS = '55555555-5555-4555-8555-555555555555';
const QID = '22222222-2222-4222-8222-000000000001';
const RUN = '33333333-3333-4333-8333-000000000001';
const NEW_RUN = '33333333-3333-4333-8333-000000000002';
const OPTIONS = [
  { id: 'o1', text: '증발' },
  { id: 'o2', text: '응결' },
];
const SUBMIT = /^(답안 )?제출$/;

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function run(overrides: Partial<PracticeRun> = {}): PracticeRun {
  return {
    id: RUN,
    workspace_id: WS,
    source: 'bank',
    mock_exam_id: null,
    random_order: false,
    seed: 1,
    total: 1,
    answered: 0,
    reached: 0,
    created_at: '2026-11-02T00:00:00Z',
    finished_at: null,
    summary: { correct: 0, incorrect: 0, pending: 0, skipped: 0 },
    ...overrides,
  };
}

function item(overrides: Partial<RunItem> = {}): RunItem {
  return {
    position: 1,
    total: 1,
    available: true,
    question_id: QID,
    question_type: 'MCQ',
    chapter_id: null,
    chapter_number: null,
    chapter_title: null,
    question_number: 1,
    stem: '물이 기체로 변하는 현상은?',
    is_multi_answer: false,
    options: OPTIONS,
    practice_session_id: null,
    session_state: null,
    attempt: null,
    ...overrides,
  };
}

const SESSION: PracticeSession = {
  id: '99999999-9999-4999-8999-000000000001',
  workspace_id: WS,
  question_id: QID,
  question_revision_id: '77777777-7777-4777-8777-777777777777',
  question_number: 1,
  question_type: 'MCQ',
  chapter_id: null,
  stem: '물이 기체로 변하는 현상은?',
  is_multi_answer: false,
  displayed_option_ids: ['o1', 'o2'],
  options: OPTIONS,
  state: 'open',
  opened_at: '2026-11-02T00:00:00Z',
};

const GRADED: SubmitResult = {
  attempt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  practice_session_id: SESSION.id,
  question_revision_id: SESSION.question_revision_id,
  state: 'graded',
  result: 'incorrect',
  correct_option_ids: ['o1'],
  accepted_answers: null,
  explanation: '해설',
  rubric: null,
};

const UNAVAILABLE = { ok: false as const, kind: 'unavailable' as const, message: '일시적인 오류' };

function client(overrides: Partial<RunClient> = {}): RunClient {
  return {
    listRange: vi.fn(async () => ({
      ok: true as const,
      data: {
        chapters: [
          { id: null, title: '챕터 없음', number: null, question_count: 2, document_id: null },
        ],
        items: ['q1', 'q2'].map((id, i) => ({
          question_id: id,
          chapter_id: null,
          question_number: i + 1,
          question_type: 'MCQ' as const,
          preview: `발문 ${i + 1}`,
          status: 'unseen' as const,
          is_favorite: false,
          needs_retry: false,
          last_graded_result: null,
          is_pending_grading: false,
        })),
      },
    })),
    create: vi.fn(async () => ({ ok: true as const, data: run({ id: NEW_RUN }) })),
    getRun: vi.fn(async () => ({ ok: true as const, data: run() })),
    getItem: vi.fn(async () => ({ ok: true as const, data: item() })),
    openSession: vi.fn(async () => ({ ok: true as const, data: SESSION })),
    submit: vi.fn(async () => ({ ok: true as const, data: GRADED })),
    selfGrade: vi.fn(),
    finish: vi.fn(async () => ({ ok: true as const, data: run({ finished_at: 'x' }) })),
    results: vi.fn(async () => ({
      ok: true as const,
      data: {
        total: 1,
        offset: 0,
        limit: 200,
        items: [
          {
            position: 1,
            question_id: QID,
            available: true,
            question_type: 'MCQ' as const,
            chapter_id: null,
            chapter_number: null,
            chapter_title: null,
            question_number: 1,
            preview: '발문',
            result: 'skipped' as const,
          },
        ],
      },
    })),
    ...overrides,
  } as RunClient;
}

function viewer(
  state: RunUrlState | null,
  c: RunClient,
  onNavigate = vi.fn(),
  invalidated?: { questionId: string; seq: number },
  onGraded?: (id: string, result: 'correct' | 'incorrect' | 'pending') => void,
) {
  return (
    <QuestionViewer
      mode="sequence"
      workspaceId={WS}
      state={state}
      archived={false}
      onNavigate={onNavigate}
      onClose={() => undefined}
      client={c}
      invalidated={invalidated}
      onGraded={onGraded}
    />
  );
}

const PICKER: RunUrlState = { step: 'picker', source: 'bank', mockExamId: null };

describe('sequence viewer async edges (QVIEW-W review)', () => {
  it('sends the observed reset epoch with bank flag writes', async () => {
    rememberPracticeEpoch(WS, QID, 17);
    vi.mocked(actions.setMyStateAction).mockResolvedValueOnce({ ok: true, data: {} } as never);
    await bankRunClient(WS).setFlags?.(QID, { is_favorite: true });
    expect(actions.setMyStateAction).toHaveBeenCalledWith(WS, QID, { is_favorite: true }, 17);
  });

  it('discards a pending submitted item after a grouped reset before its question is known', async () => {
    const oldItem = deferred<Awaited<ReturnType<RunClient['getItem']>>>();
    const freshItem = deferred<Awaited<ReturnType<RunClient['getItem']>>>();
    const getItem = vi
      .fn()
      .mockReturnValueOnce(oldItem.promise)
      .mockReturnValueOnce(freshItem.promise);
    const c = client({ getItem });
    render(viewer({ step: 'solve', runId: RUN, position: 1 }, c));
    await waitFor(() => expect(getItem).toHaveBeenCalledTimes(1));
    act(() => publishPracticeReset(WS, { [QID]: 18, otherAlias: 4 }));
    await waitFor(() => expect(getItem).toHaveBeenCalledTimes(2));
    await act(async () =>
      oldItem.resolve({
        ok: true,
        data: item({
          session_state: 'graded',
          attempt: {
            ...GRADED,
            submitted_answer: { selected_option_ids: ['o1'] },
            explanation: 'stale submitted answer',
          },
        }),
      }),
    );
    expect(screen.queryByText('stale submitted answer')).toBeNull();
    await act(async () =>
      freshItem.resolve({ ok: true, data: item({ stem: 'fresh after reset' }) }),
    );
    expect(await screen.findByRole('radio', { name: '증발' })).toBeTruthy();
  });

  it('reloads the active sequence item when a grouped reset includes an alias after it', async () => {
    const c = client();
    const state: RunUrlState = { step: 'solve', runId: RUN, position: 1 };
    render(viewer(state, c));
    await screen.findByRole('radio', { name: '증발' });
    const before = vi.mocked(c.getItem).mock.calls.length;
    act(() => publishPracticeReset(WS, { [QID]: 18, otherAlias: 4 }));
    await waitFor(() => expect(vi.mocked(c.getItem).mock.calls.length).toBeGreaterThan(before));
  });

  it('does not restore a pre-reset grade when a delayed submission returns', async () => {
    const user = userEvent.setup();
    const submitted = deferred<Awaited<ReturnType<RunClient['submit']>>>();
    const c = client({ submit: vi.fn(() => submitted.promise) });
    const onGraded = vi.fn();
    const onNavigate = vi.fn();
    const state: RunUrlState = { step: 'solve', runId: RUN, position: 1 };
    const view = render(viewer(state, c, onNavigate, undefined, onGraded));
    await user.click(await screen.findByRole('radio', { name: '증발' }));
    await user.click(screen.getByRole('button', { name: SUBMIT }));
    act(() => publishPracticeReset(WS, { [QID]: 18 }));
    view.rerender(viewer(state, c, onNavigate, { questionId: QID, seq: 1 }, onGraded));
    await act(async () => submitted.resolve({ ok: true, data: GRADED }));
    expect(onGraded).not.toHaveBeenCalled();
  });

  it('does not restore a pre-reset self-grade when its response arrives late', async () => {
    const user = userEvent.setup();
    const grading = deferred<Awaited<ReturnType<RunClient['selfGrade']>>>();
    const c = client({
      submit: vi.fn(async () => ({
        ok: true as const,
        data: { ...GRADED, result: 'pending' as const },
      })),
      selfGrade: vi.fn(() => grading.promise),
    });
    const onGraded = vi.fn();
    const onNavigate = vi.fn();
    const state: RunUrlState = { step: 'solve', runId: RUN, position: 1 };
    const view = render(viewer(state, c, onNavigate, undefined, onGraded));
    await user.click(await screen.findByRole('radio', { name: '증발' }));
    await user.click(screen.getByRole('button', { name: SUBMIT }));
    await user.click(await screen.findByRole('button', { name: '맞음' }));
    act(() => publishPracticeReset(WS, { [QID]: 18 }));
    view.rerender(viewer(state, c, onNavigate, { questionId: QID, seq: 1 }, onGraded));
    await act(async () =>
      grading.resolve({ ok: true, data: { result: 'correct' } } as Awaited<
        ReturnType<RunClient['selfGrade']>
      >),
    );
    expect(onGraded).toHaveBeenCalledTimes(1);
    expect(onGraded).toHaveBeenCalledWith(QID, 'pending');
  });

  it('reloads displayed run results when a bank question is reset', async () => {
    const c = client();
    const results: RunUrlState = { step: 'results', runId: RUN };
    const onNavigate = vi.fn();
    const view = render(viewer(results, c, onNavigate));
    await screen.findByRole('list', { name: '문제별 결과' });
    expect(c.results).toHaveBeenCalledTimes(1);
    view.rerender(viewer(results, c, onNavigate, { questionId: QID, seq: 1 }));
    await waitFor(() => expect(c.results).toHaveBeenCalledTimes(2));
  });

  it('offers a new run when an old position was reset', async () => {
    const user = userEvent.setup();
    const c = client({
      getItem: vi.fn(async () => ({
        ok: false as const,
        kind: 'reset' as const,
        message: '기록이 초기화되었습니다.',
      })),
    });
    const onNavigate = vi.fn();
    render(viewer({ step: 'solve', runId: RUN, position: 1 }, c, onNavigate));
    const button = await screen.findByRole('button', { name: '새 풀이 시작' });
    await user.click(button);
    expect(onNavigate).toHaveBeenCalledWith(PICKER, 'replace');
  });

  it('결과 보기 waits while the last position is being submitted', async () => {
    const user = userEvent.setup();
    const submitted = deferred<Awaited<ReturnType<RunClient['submit']>>>();
    const c = client({ submit: vi.fn(() => submitted.promise) });
    const onNavigate = vi.fn();
    render(viewer({ step: 'solve', runId: RUN, position: 1 }, c, onNavigate));
    const panel = screen.getByRole('dialog');
    await user.click(await within(panel).findByRole('radio', { name: '응결' }));
    await user.click(within(panel).getByRole('button', { name: SUBMIT }));
    const results = within(panel).getByRole('button', { name: '결과 보기' });
    expect(results).toBeDisabled();
    await user.click(results);
    expect(onNavigate).not.toHaveBeenCalled();
    await act(async () => submitted.resolve({ ok: true, data: GRADED }));
    expect(await within(panel).findByRole('status')).toHaveTextContent('오답');
    await user.click(within(panel).getByRole('button', { name: '결과 보기' }));
    expect(onNavigate).toHaveBeenCalledWith({ step: 'results', runId: RUN }, 'replace');
  });

  it('a run created after the panel closed, or reopened, does not navigate', async () => {
    const user = userEvent.setup();
    const created = deferred<RunActionResult<PracticeRun>>();
    const c = client({ create: vi.fn(() => created.promise) });
    const onNavigate = vi.fn();
    const view = render(viewer(PICKER, c, onNavigate));
    const panel = screen.getByRole('dialog');
    await user.click(await within(panel).findByRole('checkbox', { name: '전체 선택' }));
    await user.click(within(panel).getByRole('button', { name: '시작' }));
    view.rerender(viewer(null, c, onNavigate));
    view.rerender(viewer(PICKER, c, onNavigate));
    await act(async () => created.resolve({ ok: true, data: run({ id: NEW_RUN }) }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('처음부터 다시 after the panel closed does not navigate', async () => {
    const user = userEvent.setup();
    const created = deferred<RunActionResult<PracticeRun>>();
    const c = client({ create: vi.fn(() => created.promise) });
    const onNavigate = vi.fn();
    const view = render(viewer({ step: 'results', runId: RUN }, c, onNavigate));
    const panel = screen.getByRole('dialog');
    await within(panel).findByRole('list', { name: '문제별 결과' });
    await user.click(within(panel).getByRole('button', { name: '처음부터 다시' }));
    await waitFor(() => expect(c.create).toHaveBeenCalled());
    view.rerender(viewer(null, c, onNavigate));
    await act(async () => created.resolve({ ok: true, data: run({ id: NEW_RUN }) }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('a retried 시작 after an ambiguous failure reuses the idempotency key; a new selection does not', async () => {
    const user = userEvent.setup();
    const create = vi
      .fn<RunClient['create']>()
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockResolvedValueOnce({ ok: true, data: run({ id: NEW_RUN }) });
    const c = client({ create });
    render(viewer(PICKER, c));
    const panel = screen.getByRole('dialog');
    await user.click(await within(panel).findByRole('checkbox', { name: '전체 선택' }));
    await user.click(within(panel).getByRole('button', { name: '시작' }));
    await within(panel).findByText('일시적인 오류');
    await user.click(within(panel).getByRole('button', { name: '시작' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]?.[2]).toBe(create.mock.calls[0]?.[2]);
    // Another order setting is another request: a new key.
    await user.click(within(panel).getByRole('checkbox', { name: '무작위 순서' }));
    await user.click(within(panel).getByRole('button', { name: '시작' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    expect(create.mock.calls[2]?.[2]).not.toBe(create.mock.calls[0]?.[2]);
  });

  it('a retried 처음부터 다시 after an ambiguous failure reuses the idempotency key', async () => {
    const user = userEvent.setup();
    const create = vi
      .fn<RunClient['create']>()
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockResolvedValueOnce({ ok: true, data: run({ id: NEW_RUN }) });
    const c = client({ create });
    render(viewer({ step: 'results', runId: RUN }, c));
    const panel = screen.getByRole('dialog');
    await within(panel).findByRole('list', { name: '문제별 결과' });
    await user.click(within(panel).getByRole('button', { name: '처음부터 다시' }));
    await within(panel).findByText('일시적인 오류');
    await user.click(within(panel).getByRole('button', { name: '처음부터 다시' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]?.[2]).toBe(create.mock.calls[0]?.[2]);
  });

  it('a failed session opening can be retried with the same key, then answered', async () => {
    const user = userEvent.setup();
    const openSession = vi
      .fn<RunClient['openSession']>()
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockResolvedValueOnce({ ok: true, data: SESSION });
    const c = client({ openSession });
    render(viewer({ step: 'solve', runId: RUN, position: 1 }, c));
    const panel = screen.getByRole('dialog');
    await within(panel).findByText('일시적인 오류');
    await user.click(within(panel).getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(openSession).toHaveBeenCalledTimes(2));
    expect(openSession.mock.calls[1]?.[3]).toBe(openSession.mock.calls[0]?.[3]);
    await user.click(await within(panel).findByRole('radio', { name: '응결' }));
    expect(within(panel).getByRole('button', { name: SUBMIT })).toBeEnabled();
  });

  it('a submission whose response was lost shows the result the server kept', async () => {
    const user = userEvent.setup();
    const attempt = {
      attempt_id: GRADED.attempt_id,
      result: 'incorrect' as const,
      submitted_answer: { selected_option_ids: ['o2'], answer_text: null },
      correct_option_ids: ['o1'],
      accepted_answers: null,
      explanation: '해설',
      rubric: null,
    };
    const getItem = vi
      .fn<RunClient['getItem']>()
      .mockResolvedValueOnce({ ok: true, data: item() })
      .mockResolvedValue({ ok: true, data: item({ attempt, session_state: 'graded' }) });
    const c = client({ getItem, submit: vi.fn(async () => UNAVAILABLE) });
    render(viewer({ step: 'solve', runId: RUN, position: 1 }, c));
    const panel = screen.getByRole('dialog');
    await user.click(await within(panel).findByRole('radio', { name: '응결' }));
    await user.click(within(panel).getByRole('button', { name: SUBMIT }));
    await waitFor(() => expect(within(panel).getByRole('status')).toHaveTextContent('오답'));
    expect(within(panel).queryByRole('button', { name: SUBMIT })).toBeNull();
  });

  it('a submission that really failed keeps the answer and says so', async () => {
    const user = userEvent.setup();
    const c = client({ submit: vi.fn(async () => UNAVAILABLE) });
    render(viewer({ step: 'solve', runId: RUN, position: 1 }, c));
    const panel = screen.getByRole('dialog');
    await user.click(await within(panel).findByRole('radio', { name: '응결' }));
    await user.click(within(panel).getByRole('button', { name: SUBMIT }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      '제출하지 못했습니다. 다시 시도하세요.',
    );
    expect(within(panel).getByRole('radio', { name: '응결' })).toBeChecked();
    expect(within(panel).getByRole('button', { name: SUBMIT })).toBeEnabled();
  });

  it('a run created after the picker closed retires its key: the next opening starts a new run', async () => {
    const user = userEvent.setup();
    const first = deferred<RunActionResult<PracticeRun>>();
    const create = vi
      .fn<RunClient['create']>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ ok: true, data: run({ id: NEW_RUN }) });
    const c = client({ create });
    const onNavigate = vi.fn();
    const view = render(viewer(PICKER, c, onNavigate));
    let panel = screen.getByRole('dialog');
    await user.click(await within(panel).findByRole('checkbox', { name: '전체 선택' }));
    await user.click(within(panel).getByRole('button', { name: '시작' }));
    view.rerender(viewer(null, c, onNavigate));
    await act(async () => first.resolve({ ok: true, data: run() }));
    view.rerender(viewer(PICKER, c, onNavigate));
    panel = screen.getByRole('dialog');
    await user.click(await within(panel).findByRole('checkbox', { name: '전체 선택' }));
    await user.click(within(panel).getByRole('button', { name: '시작' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]?.[2]).not.toBe(create.mock.calls[0]?.[2]);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith(
      { step: 'solve', runId: NEW_RUN, position: 1 },
      'replace',
    );
  });

  it('an older success never retires a newer request’s key', async () => {
    const user = userEvent.setup();
    const first = deferred<RunActionResult<PracticeRun>>();
    const create = vi
      .fn<RunClient['create']>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockResolvedValue({ ok: true, data: run({ id: NEW_RUN }) });
    const c = client({ create });
    const view = render(viewer(PICKER, c));
    let panel = screen.getByRole('dialog');
    await user.click(await within(panel).findByRole('checkbox', { name: '전체 선택' }));
    await user.click(within(panel).getByRole('button', { name: '시작' }));
    view.rerender(viewer(null, c));
    view.rerender(viewer(PICKER, c));
    panel = screen.getByRole('dialog');
    await user.click(await within(panel).findByRole('checkbox', { name: '전체 선택' }));
    await user.click(within(panel).getByRole('button', { name: '시작' }));
    await within(panel).findByText('일시적인 오류');
    // The first opening's run arrives late: the second opening's key must survive it.
    await act(async () => first.resolve({ ok: true, data: run() }));
    await user.click(within(panel).getByRole('button', { name: '시작' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    expect(create.mock.calls[2]?.[2]).toBe(create.mock.calls[1]?.[2]);
  });

  it('a 처음부터 다시 run created after the panel closed retires its key', async () => {
    const user = userEvent.setup();
    const first = deferred<RunActionResult<PracticeRun>>();
    const create = vi
      .fn<RunClient['create']>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ ok: true, data: run({ id: NEW_RUN }) });
    const c = client({ create });
    const results: RunUrlState = { step: 'results', runId: RUN };
    const view = render(viewer(results, c));
    let panel = screen.getByRole('dialog');
    await within(panel).findByRole('list', { name: '문제별 결과' });
    await user.click(within(panel).getByRole('button', { name: '처음부터 다시' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    view.rerender(viewer(null, c));
    await act(async () => first.resolve({ ok: true, data: run() }));
    view.rerender(viewer(results, c));
    panel = screen.getByRole('dialog');
    await within(panel).findByRole('list', { name: '문제별 결과' });
    await user.click(within(panel).getByRole('button', { name: '처음부터 다시' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]?.[2]).not.toBe(create.mock.calls[0]?.[2]);
  });
});

it('focuses a bank run heading on handoff and returns to its original opener on close', async () => {
  const opener = document.createElement('button');
  document.body.append(opener);
  const c = client();
  const view = render(viewer({ step: 'solve', runId: RUN, position: 1 }, c));
  const heading = await screen.findByRole('heading', { name: /1번/ });
  act(() => window.dispatchEvent(new CustomEvent('quiz:bank-run-transition', { detail: opener })));
  expect(heading).toHaveFocus();
  view.rerender(viewer(null, c));
  await waitFor(() => expect(opener).toHaveFocus());
  opener.remove();
});
