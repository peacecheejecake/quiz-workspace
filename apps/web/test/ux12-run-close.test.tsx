// @vitest-environment jsdom
// UX12-RUNCLOSE (docs/screens/ux12-run-close.md): closing an unfinished run asks first, once,
// whichever way it was closed; every other step closes at once. Browser half:
// tests/e2e/questions/ux12-run-close.spec.ts.
import './dom-setup';
import { act, screen, waitFor, within } from '@testing-library/react';
import { renderWithToasts as render } from './render-with-toasts';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PracticeSession, SubmitResult } from '../src/lib/questions/practice-actions';
import type { PracticeRun, RunItem, RunUrlState } from '../src/lib/questions/practice-runs';
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
const SOLVE: RunUrlState = { step: 'solve', runId: RUN, position: 1 };

function run(overrides: Partial<PracticeRun> = {}): PracticeRun {
  return {
    id: RUN,
    workspace_id: WS,
    source: 'bank',
    mock_exam_id: null,
    random_order: false,
    shuffle_options: false,
    seed: 1,
    total: 2,
    answered: 0,
    reached: 1,
    created_at: '2026-11-02T00:00:00Z',
    finished_at: null,
    summary: { correct: 0, incorrect: 0, pending: 0, skipped: 0 },
    ...overrides,
  };
}

function item(overrides: Partial<RunItem> = {}): RunItem {
  return {
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

function client(overrides: Partial<RunClient> = {}): RunClient {
  return {
    listRange: vi.fn(async () => ({ ok: true as const, data: { chapters: [], items: [] } })),
    create: vi.fn(),
    getRun: vi.fn(async () => ({ ok: true as const, data: run() })),
    getItem: vi.fn(async () => ({ ok: true as const, data: item() })),
    openSession: vi.fn(async () => ({ ok: true as const, data: SESSION })),
    submit: vi.fn(async () => ({ ok: true as const, data: GRADED })),
    selfGrade: vi.fn(),
    finish: vi.fn(async () => ({ ok: true as const, data: run({ finished_at: 'x' }) })),
    results: vi.fn(async () => ({
      ok: true as const,
      data: { total: 0, offset: 0, limit: 200, items: [] },
    })),
    ...overrides,
  } as RunClient;
}

let navigate: (state: RunUrlState | null) => void = () => undefined;

function Harness({
  given,
  initial,
  onClose,
}: {
  readonly given: RunClient;
  readonly initial: RunUrlState;
  readonly onClose: () => void;
}) {
  const [state, setState] = useState<RunUrlState | null>(initial);
  useEffect(() => {
    navigate = setState;
  }, []);
  return (
    <QuestionViewer
      mode="sequence"
      workspaceId={WS}
      state={state}
      archived={false}
      client={given}
      onNavigate={(next) => setState(next)}
      onClose={() => {
        onClose();
        setState(null);
      }}
    />
  );
}

const confirm = () => screen.queryByRole('alertdialog');
const closeButton = () => screen.getByRole('button', { name: '패널 닫기', hidden: true });

async function ready(given: RunClient, initial: RunUrlState = SOLVE) {
  const onClose = vi.fn();
  render(<Harness given={given} initial={initial} onClose={onClose} />);
  await screen.findByRole('radio', { name: /증발/ });
  return onClose;
}

describe('UX12-RUNCLOSE', () => {
  it('UX12-RUNCLOSE-AC01 the close button asks and focus starts on 계속 풀기', async () => {
    const user = userEvent.setup();
    const onClose = await ready(client());
    await user.click(closeButton());
    const dialog = await screen.findByRole('alertdialog', { name: '풀이를 닫을까요?' });
    expect(dialog.textContent).toContain('이어 풀기');
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: '계속 풀기' })).toBe(
        document.activeElement,
      ),
    );
  });

  it('UX12-RUNCLOSE-AC02 계속 풀기 and Escape stay on the question, the choice kept', async () => {
    const user = userEvent.setup();
    const onClose = await ready(client());
    await user.click(screen.getByRole('radio', { name: /증발/ }));
    await user.click(closeButton());
    await user.click(await screen.findByRole('button', { name: '계속 풀기' }));
    await waitFor(() => expect(confirm()).toBeNull());
    await user.click(closeButton());
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(confirm()).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: /증발/, checked: true })).toBeTruthy();
    await waitFor(() => expect(closeButton()).toBe(document.activeElement));
  });

  it('UX12-RUNCLOSE-AC03 닫기 closes once with no second dialog', async () => {
    const user = userEvent.setup();
    const onClose = await ready(client());
    await user.click(closeButton());
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(confirm()).toBeNull());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('UX12-RUNCLOSE-AC04 Escape and the backdrop show the same single confirm', async () => {
    const user = userEvent.setup();
    const onClose = await ready(client());
    await user.keyboard('{Escape}');
    expect(await screen.findAllByRole('alertdialog')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '계속 풀기' }));
    await waitFor(() => expect(confirm()).toBeNull());
    const backdrop = document.querySelector<HTMLElement>('.qz-backdrop[data-layer="panel"]');
    if (!backdrop) throw new Error('no backdrop');
    await user.click(backdrop);
    expect(await screen.findAllByRole('alertdialog')).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('UX12-RUNCLOSE-AC05 a finished run closes at once', async () => {
    const user = userEvent.setup();
    const onClose = await ready(
      client({
        getRun: vi.fn(async () => ({ ok: true as const, data: run({ finished_at: 'x' }) })),
      }),
    );
    await user.click(closeButton());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirm()).toBeNull();
  });

  it('UX12-RUNCLOSE-AC05 submitting the last open position leaves nothing to ask about', async () => {
    const user = userEvent.setup();
    const onClose = await ready(
      client({ getRun: vi.fn(async () => ({ ok: true as const, data: run({ answered: 1 }) })) }),
    );
    await user.click(screen.getByRole('radio', { name: /증발/ }));
    await user.click(screen.getByRole('button', { name: /제출/ }));
    await screen.findAllByText('해설');
    await user.click(closeButton());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirm()).toBeNull();
  });

  it('UX12-RUNCLOSE-AC05 the results step and the range step close at once', async () => {
    const user = userEvent.setup();
    const onResults = vi.fn();
    const first = render(
      <Harness given={client()} initial={{ step: 'results', runId: RUN }} onClose={onResults} />,
    );
    await screen.findByRole('heading', { name: '풀이 결과' });
    await user.click(closeButton());
    expect(onResults).toHaveBeenCalledTimes(1);
    first.unmount();
    const onPicker = vi.fn();
    render(
      <Harness
        given={client()}
        initial={{ step: 'picker', source: 'bank', mockExamId: null }}
        onClose={onPicker}
      />,
    );
    await user.click(closeButton());
    expect(onPicker).toHaveBeenCalledTimes(1);
    expect(confirm()).toBeNull();
  });

  it('UX12-RUNCLOSE-AC07 moving under the confirm drops it for good', async () => {
    const user = userEvent.setup();
    await ready(client());
    await user.click(closeButton());
    await screen.findByRole('alertdialog');
    act(() => navigate({ ...SOLVE, position: 2 } as RunUrlState));
    await waitFor(() => expect(confirm()).toBeNull());
    act(() => navigate(SOLVE));
    await screen.findByRole('radio', { name: /증발/ });
    expect(confirm()).toBeNull();
  });
});
