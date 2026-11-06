// @vitest-environment jsdom
// UX12-RETRYINPLACE (docs/screens/ux12-retry-in-place.md): 다시 풀기 turns the position back to
// solving in the same panel. Browser half: tests/e2e/questions/ux12-retry-in-place.spec.ts.
import './dom-setup';
import { screen, waitFor } from '@testing-library/react';
import { renderWithToasts as render } from './render-with-toasts';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PracticeSession, SubmitResult } from '../src/lib/questions/practice-actions';
import type { PracticeRun, RunItem } from '../src/lib/questions/practice-runs';
import type { RunClient } from '../src/components/questions/viewer/question-viewer';

vi.mock('../src/lib/questions/practice-actions', () => ({
  submitPracticeAction: vi.fn(),
  selfGradePracticeAction: vi.fn(),
  setMyStateAction: vi.fn(),
  lookupOverviewQuestionAction: vi.fn(),
}));
vi.mock('../src/lib/questions/actions', () => ({
  getQuestionAction: vi.fn(),
  getQuestionRevisionAction: vi.fn(),
}));

const { QuestionViewer } = await import('../src/components/questions/viewer/question-viewer');

const WS = '55555555-5555-4555-8555-555555555555';
const QID = '22222222-2222-4222-8222-000000000001';
const RUN = '33333333-3333-4333-8333-000000000001';
const OPTIONS = [
  { id: 'o1', text: '증발' },
  { id: 'o2', text: '응결' },
];
const AGAIN = { name: /^다시 풀기$/ };

const run = (overrides: Partial<PracticeRun> = {}): PracticeRun => ({
  id: RUN,
  workspace_id: WS,
  source: 'bank',
  mock_exam_id: null,
  random_order: false,
  shuffle_options: false,
  seed: 1,
  total: 2,
  answered: 1,
  reached: 1,
  created_at: '2026-11-02T00:00:00Z',
  finished_at: null,
  summary: { correct: 1, incorrect: 0, pending: 0, skipped: 0 },
  ...overrides,
});

const open: RunItem = {
  position: 1,
  total: 2,
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
};

const graded: RunItem = {
  ...open,
  practice_session_id: '99999999-9999-4999-8999-000000000009',
  session_state: 'graded',
  attempt: {
    attempt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000009',
    result: 'correct',
    submitted_answer: { selected_option_ids: ['o1'], answer_text: null },
    correct_option_ids: ['o1'],
    accepted_answers: null,
    explanation: '이전 해설',
    rubric: null,
  },
};

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
  displayed_option_ids: ['o2', 'o1'],
  options: [...OPTIONS].reverse(),
  state: 'open',
  opened_at: '2026-11-02T00:00:00Z',
};

const RESULT: SubmitResult = {
  attempt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  practice_session_id: SESSION.id,
  question_revision_id: SESSION.question_revision_id,
  state: 'graded',
  result: 'incorrect',
  correct_option_ids: ['o1'],
  accepted_answers: null,
  explanation: '새 해설',
  rubric: null,
};

function client(overrides: Partial<RunClient> = {}): RunClient {
  return {
    listRange: vi.fn(),
    create: vi.fn(),
    getRun: vi.fn(async () => ({ ok: true as const, data: run() })),
    getItem: vi.fn(async () => ({ ok: true as const, data: graded })),
    openSession: vi.fn(async () => ({ ok: true as const, data: SESSION })),
    submit: vi.fn(async () => ({ ok: true as const, data: RESULT })),
    selfGrade: vi.fn(),
    reopenPosition: vi.fn(async () => ({ ok: true as const, data: null })),
    openRetrySession: vi.fn(async () => ({ ok: true as const, data: SESSION })),
    finish: vi.fn(),
    results: vi.fn(),
    ...overrides,
  } as RunClient;
}

function show(given: RunClient) {
  render(
    <QuestionViewer
      mode="sequence"
      workspaceId={WS}
      state={{ step: 'solve', runId: RUN, position: 1 }}
      archived={false}
      client={given}
      onNavigate={() => undefined}
      onClose={() => undefined}
    />,
  );
}

describe('UX12-RETRYINPLACE', () => {
  it('UX12-RETRYINPLACE-AC01 reopens the position in the same panel, unselected and clean', async () => {
    const user = userEvent.setup();
    const reads = [graded, open];
    const given = client({
      getItem: vi.fn(async () => ({ ok: true as const, data: reads.shift() ?? open })),
    });
    show(given);
    await user.click(await screen.findByRole('button', AGAIN));

    await screen.findByRole('button', { name: /제출/ });
    expect(given.reopenPosition).toHaveBeenCalledWith(RUN, 1);
    expect(given.openRetrySession).not.toHaveBeenCalled();
    expect(given.openSession).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByText('이전 해설')).toBeNull();
    expect(screen.queryByRole('radio', { checked: true })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /1번/ })).toBe(document.activeElement),
    );
  });

  it('UX12-RETRYINPLACE-AC01 a refused reopen keeps the result and says why', async () => {
    const user = userEvent.setup();
    const given = client({
      reopenPosition: vi.fn(async () => ({
        ok: false as const,
        kind: 'unavailable' as const,
        message: '일시적인 오류',
      })),
    });
    show(given);
    await user.click(await screen.findByRole('button', AGAIN));
    expect(await screen.findByText('일시적인 오류')).toBeTruthy();
    expect(screen.getAllByText('이전 해설').length).toBeGreaterThan(0);
  });

  it('UX12-RETRYINPLACE-AC02 the new submission grades through the new session', async () => {
    const user = userEvent.setup();
    const reads = [graded, open];
    const given = client({
      getItem: vi.fn(async () => ({ ok: true as const, data: reads.shift() ?? open })),
    });
    show(given);
    await user.click(await screen.findByRole('button', AGAIN));
    await user.click(await screen.findByRole('radio', { name: /응결/ }));
    await user.click(screen.getByRole('button', { name: /제출/ }));
    await screen.findAllByText('새 해설');
    expect(given.submit).toHaveBeenCalledWith(SESSION.id, { selected_option_ids: ['o2'] });
  });

  it('UX12-RETRYINPLACE-AC06 a finished run solves on a session outside the run', async () => {
    const user = userEvent.setup();
    const given = client({
      getRun: vi.fn(async () => ({
        ok: true as const,
        data: run({ finished_at: '2026-11-02T01:00:00Z' }),
      })),
    });
    show(given);
    await user.click(await screen.findByRole('button', AGAIN));

    await user.click(await screen.findByRole('radio', { name: /응결/ }));
    expect(given.reopenPosition).not.toHaveBeenCalled();
    expect(given.openRetrySession).toHaveBeenCalledTimes(1);
    expect(given.openSession).not.toHaveBeenCalled();
    expect(screen.queryByText('이전 해설')).toBeNull();
    await user.click(screen.getByRole('button', { name: /제출/ }));
    await screen.findAllByText('새 해설');
    expect(given.submit).toHaveBeenCalledWith(SESSION.id, { selected_option_ids: ['o2'] });
    expect(given.getRun).toHaveBeenCalledTimes(1);
  });

  it('UX12-RETRYINPLACE-AC06 a failed submission keeps the retry, the answer and the error', async () => {
    const user = userEvent.setup();
    const given = client({
      getRun: vi.fn(async () => ({
        ok: true as const,
        data: run({ finished_at: '2026-11-02T01:00:00Z' }),
      })),
      submit: vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          kind: 'alreadySubmitted',
          message: '제출이 거절되었습니다',
        })
        .mockResolvedValueOnce({ ok: true, data: RESULT }),
    });
    show(given);
    await user.click(await screen.findByRole('button', AGAIN));
    await user.click(await screen.findByRole('radio', { name: /응결/ }));
    await user.click(screen.getByRole('button', { name: /제출/ }));

    expect(await screen.findByText('제출이 거절되었습니다')).toBeTruthy();
    expect(given.getItem).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('이전 해설')).toBeNull();
    expect(screen.getByRole('radio', { name: /응결/, checked: true })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /제출/ }));
    await screen.findAllByText('새 해설');
    expect(given.submit).toHaveBeenLastCalledWith(SESSION.id, { selected_option_ids: ['o2'] });
  });
});
