// @vitest-environment jsdom
import './dom-setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SeparateRetry } from '../src/components/questions/viewer/separate-retry';

const calls = vi.hoisted(() => ({ open: vi.fn(), submit: vi.fn() }));
vi.mock('../src/components/questions/mock-exams/mock-exam-client', () => ({
  createMockPracticeApi: () => ({ openStandaloneSession: calls.open, submit: calls.submit }),
}));
vi.mock('../src/lib/questions/practice-run-client', () => ({
  createPracticeRunApi: () => ({ openRetrySession: calls.open }),
}));
vi.mock('../src/lib/questions/practice-actions', () => ({
  submitPracticeAction: vi.fn(),
  selfGradePracticeAction: vi.fn(),
}));

it('UX11-RETURN-AC01 submits a separate mock session using option IDs', async () => {
  calls.open.mockResolvedValue({
    ok: true,
    data: {
      id: 'retry-session',
      workspace_id: 'workspace',
      question_id: 'question',
      question_type: 'MCQ',
      stem: 'Synthetic question',
      is_multi_answer: false,
      displayed_option_ids: ['a', 'b'],
      options: [
        { id: 'a', text: 'First' },
        { id: 'b', text: 'Second' },
      ],
    },
  });
  calls.submit.mockResolvedValue({
    ok: true,
    data: {
      result: 'correct',
      correct_option_ids: ['a'],
      accepted_answers: null,
      explanation: null,
      rubric: null,
    },
  });
  render(
    <SeparateRetry
      workspaceId="workspace"
      questionId="question"
      source="mock"
      runId="run"
      position={1}
      resetEpoch={null}
      onClose={() => undefined}
    />,
  );
  fireEvent.click(await screen.findByRole('radio', { name: 'First' }));
  fireEvent.click(screen.getByRole('button', { name: '제출' }));
  expect(await screen.findByText('정답입니다.')).toBeTruthy();
  expect(calls.open).toHaveBeenCalledWith('run', 1, expect.any(String), null);
  expect(calls.submit).toHaveBeenCalledWith('retry-session', { selected_option_ids: ['a'] });
});

it('UX11-RETURN-AC01 closes a revealed bank retry when that question is reset', async () => {
  const { publishPracticeReset } = await import('../src/lib/questions/practice-reset-events');
  const actions = await import('../src/lib/questions/practice-actions');
  calls.open.mockResolvedValue({
    ok: true,
    data: {
      id: 'retry-session',
      workspace_id: 'workspace',
      question_id: 'question',
      question_type: 'MCQ',
      stem: 'Synthetic question',
      is_multi_answer: false,
      displayed_option_ids: ['a'],
      options: [{ id: 'a', text: 'First' }],
    },
  });
  vi.mocked(actions.submitPracticeAction).mockResolvedValue({
    ok: true,
    data: {
      result: 'correct',
      correct_option_ids: ['a'],
      accepted_answers: null,
      explanation: null,
      rubric: null,
    },
  } as never);
  const close = vi.fn();
  render(
    <SeparateRetry
      workspaceId="workspace"
      questionId="question"
      source="bank"
      runId="run"
      position={1}
      resetEpoch={0}
      onClose={close}
    />,
  );
  fireEvent.click(await screen.findByRole('radio', { name: 'First' }));
  fireEvent.click(screen.getByRole('button', { name: '제출' }));
  expect(await screen.findByText('정답입니다.')).toBeTruthy();
  const { act } = await import('@testing-library/react');
  act(() => publishPracticeReset('workspace', { question: 1 }));
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByText('정답입니다.')).toBeNull();
  expect(screen.queryByText('Synthetic question')).toBeNull();
});

it('UX11-RETURN-AC01 ignores a late retry session after a bank reset', async () => {
  const { publishPracticeReset } = await import('../src/lib/questions/practice-reset-events');
  const { act } = await import('@testing-library/react');
  let resolve!: (value: unknown) => void;
  calls.open.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const close = vi.fn();
  render(
    <SeparateRetry
      workspaceId="workspace"
      questionId="late-question"
      source="bank"
      runId="run"
      position={1}
      resetEpoch={0}
      onClose={close}
    />,
  );
  act(() => publishPracticeReset('workspace', { 'late-question': 1 }));
  await act(async () => resolve({ ok: true, data: { id: 'late', stem: 'Stale answer' } }));
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByText('Stale answer')).toBeNull();
});

it('UX11-RETURN-AC01 ignores a late grade after a bank reset', async () => {
  const { publishPracticeReset } = await import('../src/lib/questions/practice-reset-events');
  const { act } = await import('@testing-library/react');
  const actions = await import('../src/lib/questions/practice-actions');
  calls.open.mockResolvedValue({
    ok: true,
    data: {
      id: 'retry-session',
      workspace_id: 'workspace',
      question_id: 'late-grade',
      question_type: 'MCQ',
      stem: 'Question',
      is_multi_answer: false,
      displayed_option_ids: ['a'],
      options: [{ id: 'a', text: 'First' }],
    },
  });
  let resolve!: (value: unknown) => void;
  vi.mocked(actions.submitPracticeAction).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }) as never,
  );
  const close = vi.fn();
  const graded = vi.fn();
  render(
    <SeparateRetry
      workspaceId="workspace"
      questionId="late-grade"
      source="bank"
      runId="run"
      position={1}
      resetEpoch={0}
      onClose={close}
      onGraded={graded}
    />,
  );
  fireEvent.click(await screen.findByRole('radio', { name: 'First' }));
  fireEvent.click(screen.getByRole('button', { name: '제출' }));
  act(() => publishPracticeReset('workspace', { 'late-grade': 1 }));
  await act(async () => resolve({ ok: true, data: { result: 'correct' } }));
  expect(close).toHaveBeenCalledOnce();
  expect(graded).not.toHaveBeenCalled();
  expect(screen.queryByText('정답입니다.')).toBeNull();
});
