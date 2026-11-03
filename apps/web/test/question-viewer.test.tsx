// @vitest-environment jsdom
// QVIEW-01-C06 (docs/screens/question-viewer.md "계약 요구사항"): the QuestionViewer component
// contract. Every mode exists; `read-only` and `manage` render no submit UI; `sequence(mock)`
// renders no favorite / retry; the UX7 rules hold per mode — `displayStem` (the trailing empty
// answer mark hidden), the hidden 보기 label, the grading border with its 정답 / 내 선택 text
// (QPLAY-01-AC12/AC13), and the practice-mode session cache (practice-cache.test.tsx covers
// its rules in full). The call sites' use of the viewer is checked at the bottom.
import './dom-setup';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PracticeSession, SubmitResult } from '../src/lib/questions/practice-actions';
import type { PracticeRun, RunItem } from '../src/lib/questions/practice-runs';
import type { RunClient } from '../src/components/questions/viewer/question-viewer';

const openSession = vi.fn<(ws: string, q: string, key: string) => Promise<unknown>>();
vi.mock('../src/lib/questions/practice-actions', () => ({
  openPracticeSessionAction: (ws: string, q: string, key: string) => openSession(ws, q, key),
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
const STEM = '물이 기체로 변하는 현상은? ( )';
const SHOWN_STEM = '물이 기체로 변하는 현상은?';

const OPTIONS = [
  { id: 'o2', text: '응결' },
  { id: 'o1', text: '증발' },
];

function session(overrides: Partial<PracticeSession> = {}): PracticeSession {
  return {
    id: '99999999-9999-4999-8999-000000000001',
    workspace_id: WS,
    question_id: QID,
    question_revision_id: '77777777-7777-4777-8777-777777777777',
    question_number: 1,
    question_type: 'MCQ',
    chapter_id: null,
    stem: STEM,
    is_multi_answer: false,
    displayed_option_ids: OPTIONS.map((o) => o.id),
    options: OPTIONS,
    state: 'open',
    opened_at: '2026-11-02T00:00:00Z',
    ...overrides,
  };
}

const REVISION = {
  id: '88888888-8888-4888-8888-000000000001',
  version: 1,
  stem: STEM,
  options: [
    { id: 'o1', text: '증발' },
    { id: 'o2', text: '응결' },
  ],
  correct_option_ids: ['o1'],
  accepted_answers: null,
  is_multi_answer: false,
  explanation: '증발은 액체가 기체로 변하는 현상이다.',
  rubric: null,
  created_at: '2026-11-02T00:00:00Z',
};

const SUBMIT_UI = /^(답안 )?제출$/;

function run(overrides: Partial<PracticeRun> = {}): PracticeRun {
  return {
    id: RUN,
    workspace_id: WS,
    source: 'bank',
    mock_exam_id: null,
    random_order: false,
    seed: 1,
    total: 2,
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
    total: 2,
    available: true,
    question_id: QID,
    question_type: 'MCQ',
    chapter_id: '66666666-6666-4666-8666-000000000001',
    chapter_number: 3,
    chapter_title: '3장 물의 순환',
    question_number: 12,
    stem: STEM,
    is_multi_answer: false,
    options: OPTIONS,
    practice_session_id: null,
    session_state: null,
    attempt: null,
    ...overrides,
  };
}

const graded: SubmitResult = {
  attempt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  practice_session_id: session().id,
  question_revision_id: session().question_revision_id,
  state: 'graded',
  result: 'incorrect',
  correct_option_ids: ['o1'],
  accepted_answers: null,
  explanation: REVISION.explanation,
  rubric: null,
};

function fakeClient(overrides: Partial<RunClient> = {}): RunClient {
  return {
    listRange: vi.fn(async () => ({ ok: true as const, data: { chapters: [], items: [] } })),
    create: vi.fn(async () => ({ ok: true as const, data: run() })),
    getRun: vi.fn(async () => ({ ok: true as const, data: run() })),
    getItem: vi.fn(async () => ({ ok: true as const, data: item() })),
    openSession: vi.fn(async () => ({ ok: true as const, data: session() })),
    submit: vi.fn(async () => ({ ok: true as const, data: graded })),
    selfGrade: vi.fn(),
    finish: vi.fn(async () => ({ ok: true as const, data: run() })),
    results: vi.fn(async () => ({
      ok: true as const,
      data: { total: 0, offset: 0, limit: 200, items: [] },
    })),
    flags: vi.fn(async () => ({ is_favorite: false, needs_retry: false })),
    setFlags: vi.fn(),
    ...overrides,
  } as RunClient;
}

const noop = () => undefined;

beforeEach(() => {
  openSession.mockReset();
  openSession.mockImplementation(async () => ({ ok: true, data: session() }));
});

describe('QVIEW-01-C06 QuestionViewer modes', () => {
  it('practice: a modal panel with the study toggles, the answer body and 제출', async () => {
    render(
      <QuestionViewer
        mode="practice"
        workspaceId={WS}
        question={{
          id: QID,
          title: '3장 12번 문제',
          chapterTitle: '3장 물의 순환',
          questionType: 'MCQ',
          preview: STEM,
          isFavorite: false,
          needsRetry: false,
        }}
        readOnly={false}
        onClose={noop}
        onFlagsChange={noop}
        onViewed={noop}
      />,
    );
    const panel = screen.getByRole('dialog', { name: '3장 12번 문제' });
    expect(panel).toHaveAttribute('aria-modal', 'true');
    await within(panel).findByRole('radiogroup');
    expect(within(panel).getByText(SHOWN_STEM)).toBeInTheDocument();
    expect(within(panel).queryByText(STEM)).toBeNull();
    // UX7-QDISPLAY: the radiogroup keeps 보기 as its name, no visible 보기 text.
    expect(within(panel).getByRole('radiogroup', { name: '보기' })).toBeInTheDocument();
    expect(within(panel).getByText(/^보기$/)).toHaveClass('qz-visually-hidden');
    expect(within(panel).getByRole('button', { name: SUBMIT_UI })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /즐겨찾기/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /다시 풀기/ })).toBeInTheDocument();
    expect(openSession).toHaveBeenCalledTimes(1);
  });

  it('manage: the 문제 상세 dialog shows the answers and renders no submit UI', () => {
    render(
      <QuestionViewer
        mode="manage"
        workspaceId={WS}
        open
        onClose={noop}
        focus="answers"
        load={{
          status: 'ready',
          question: {
            id: QID,
            workspace_id: WS,
            question_type: 'MCQ',
            publication_status: 'CONFIRMED',
            chapter_id: null,
            question_number: 1,
            revision: REVISION,
            revisions: [{ id: REVISION.id, version: 1, created_at: REVISION.created_at }],
            sources: [],
          } as never,
        }}
        onRetry={noop}
        documents={[]}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: '문제 상세' });
    expect(within(dialog).getByText(SHOWN_STEM)).toBeInTheDocument();
    expect(within(dialog).getByRole('list', { name: '보기' })).toBeInTheDocument();
    // The correct option says so in text (not a grading result: no 내 선택, no radio).
    expect(within(dialog).getByText('정답')).toBeInTheDocument();
    expect(within(dialog).queryByRole('radio')).toBeNull();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: SUBMIT_UI })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /즐겨찾기|다시 풀기/ })).toBeNull();
  });

  it('read-only: a modal preview (UX9) with the answers, no submit UI and no toggles', () => {
    render(
      <QuestionViewer
        mode="read-only"
        question={{ questionType: 'MCQ', revision: REVISION }}
        title="1번 문제"
        description="객관식 · 1장 · 조회 전용"
        onClose={noop}
      />,
    );
    const panel = screen.getByRole('dialog', { name: '1번 문제' });
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(within(panel).getByText(SHOWN_STEM)).toBeInTheDocument();
    expect(within(panel).getByText(REVISION.explanation)).toBeInTheDocument();
    expect(within(panel).queryByRole('radio')).toBeNull();
    expect(within(panel).queryByRole('button', { name: SUBMIT_UI })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /즐겨찾기|다시 풀기/ })).toBeNull();
  });

  it('sequence(bank): the position title, progress, toggles; after 제출 the grading border text', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    render(
      <QuestionViewer
        mode="sequence"
        workspaceId={WS}
        state={{ step: 'solve', runId: RUN, position: 1 }}
        archived={false}
        onNavigate={noop}
        onClose={noop}
        client={client}
      />,
    );
    const panel = screen.getByRole('dialog');
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(await within(panel).findByRole('heading', { name: '3장 12번' })).toBeInTheDocument();
    expect(await within(panel).findByText(SHOWN_STEM)).toBeInTheDocument();
    expect(within(panel).getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      '2문제 중 1번째',
    );
    expect(await within(panel).findByRole('button', { name: /즐겨찾기/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /다시 풀기/ })).toBeInTheDocument();
    // No answer before a submission: the radios have no 정답 mark.
    expect(within(panel).queryByText('정답')).toBeNull();

    await user.click(within(panel).getByRole('radio', { name: '응결' }));
    await user.click(within(panel).getByRole('button', { name: SUBMIT_UI }));
    expect(await within(panel).findByRole('status')).toHaveTextContent('오답');
    expect(client.submit).toHaveBeenCalledWith(session().id, { selected_option_ids: ['o2'] });
    expect(within(panel).getByRole('radio', { name: '증발' })).toHaveAccessibleDescription('정답');
    expect(within(panel).getByRole('radio', { name: '응결' })).toHaveAccessibleDescription(
      '내 선택',
    );
    expect(within(panel).queryByRole('button', { name: SUBMIT_UI })).toBeNull();
    expect(within(panel).getByRole('button', { name: '다음' })).toBeInTheDocument();
  });

  it('sequence(bank): UX9-RETRY-OPT toggles flip before the response, never busy, failures roll back', async () => {
    const user = userEvent.setup();
    const held: { patch: object; resolve: (value: unknown) => void }[] = [];
    const setFlags = vi.fn(
      (_qid: string, patch: object) => new Promise((resolve) => held.push({ patch, resolve })),
    );
    const onFlagsSaved = vi.fn();
    const onFlagsFailed = vi.fn();
    render(
      <QuestionViewer
        mode="sequence"
        workspaceId={WS}
        state={{ step: 'solve', runId: RUN, position: 1 }}
        archived={false}
        onNavigate={noop}
        onClose={noop}
        onFlagsSaved={onFlagsSaved}
        onFlagsFailed={onFlagsFailed}
        client={fakeClient({ setFlags: setFlags as unknown as RunClient['setFlags'] })}
      />,
    );
    const panel = screen.getByRole('dialog');
    await user.click(await within(panel).findByRole('button', { name: '다시 풀기 표시' }));
    const retry = within(panel).getByRole('button', { name: '다시 풀기 해제' });
    expect(retry).toHaveAttribute('data-state', 'on');
    expect(retry).not.toHaveAttribute('aria-disabled');
    await user.click(within(panel).getByRole('button', { name: '즐겨찾기 추가' }));
    expect(within(panel).getByRole('button', { name: '즐겨찾기 해제' })).toBeInTheDocument();
    expect(retry).toHaveAttribute('data-state', 'on');
    expect(held.map((h) => h.patch)).toEqual([{ needs_retry: true }]);
    await act(async () =>
      held[0]?.resolve({
        ok: true,
        data: { question_id: QID, is_favorite: false, needs_retry: true },
      }),
    );
    expect(held.map((h) => h.patch)).toEqual([{ needs_retry: true }, { is_favorite: true }]);
    expect(onFlagsSaved).not.toHaveBeenCalled();
    await act(async () => held[1]?.resolve({ ok: false, kind: 'unavailable', message: '실패' }));
    expect(within(panel).getByRole('button', { name: '즐겨찾기 추가' })).toBeInTheDocument();
    expect(retry).toHaveAttribute('data-state', 'on');
    expect(onFlagsFailed).toHaveBeenCalledWith('실패');
    // The retry change was saved before the failure: the screen refreshes its heatmap.
    expect(onFlagsSaved).toHaveBeenCalledWith(QID, { is_favorite: false, needs_retry: true });
  });

  it('sequence(mock): "문제 k" and no favorite / retry toggle', async () => {
    const client = fakeClient({ flags: undefined, setFlags: undefined });
    render(
      <QuestionViewer
        mode="sequence"
        workspaceId={WS}
        source="mock"
        state={{ step: 'solve', runId: RUN, position: 1 }}
        archived={false}
        onNavigate={noop}
        onClose={noop}
        client={client}
        headerExtra={() => <button type="button">문제 정보</button>}
      />,
    );
    const panel = screen.getByRole('dialog');
    expect(await within(panel).findByRole('heading', { name: '문제 1' })).toBeInTheDocument();
    expect(await within(panel).findByRole('button', { name: SUBMIT_UI })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /즐겨찾기|다시 풀기/ })).toBeNull();
    expect(within(panel).queryByRole('button', { name: '문제 정보' })).toBeNull();
  });

  it('sequence: a submitted position is shown read-only from its attempt, without 제출', async () => {
    const client = fakeClient({
      getItem: vi.fn(async () => ({
        ok: true as const,
        data: item({
          attempt: {
            attempt_id: graded.attempt_id,
            result: 'incorrect',
            submitted_answer: { selected_option_ids: ['o2'], answer_text: null },
            correct_option_ids: ['o1'],
            accepted_answers: null,
            explanation: REVISION.explanation,
            rubric: null,
          },
          session_state: 'graded',
        }),
      })),
    });
    render(
      <QuestionViewer
        mode="sequence"
        workspaceId={WS}
        state={{ step: 'solve', runId: RUN, position: 1 }}
        archived={false}
        onNavigate={noop}
        onClose={noop}
        client={client}
      />,
    );
    const panel = screen.getByRole('dialog');
    expect(await within(panel).findByRole('status')).toHaveTextContent('오답');
    expect(within(panel).getByRole('radio', { name: '응결' })).toBeChecked();
    expect(within(panel).getByRole('radio', { name: '응결' })).toBeDisabled();
    expect(within(panel).queryByRole('button', { name: SUBMIT_UI })).toBeNull();
    expect(client.openSession).not.toHaveBeenCalled();
  });

  it('sequence in an archived workspace: answers can be chosen, 제출 is disabled with the reason', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    render(
      <QuestionViewer
        mode="sequence"
        workspaceId={WS}
        state={{ step: 'solve', runId: RUN, position: 1 }}
        archived
        onNavigate={noop}
        onClose={noop}
        client={client}
      />,
    );
    const panel = screen.getByRole('dialog');
    await user.click(await within(panel).findByRole('radio', { name: '증발' }));
    expect(within(panel).getByRole('radio', { name: '증발' })).toBeChecked();
    expect(within(panel).getByRole('button', { name: SUBMIT_UI })).toBeDisabled();
    expect(
      within(panel).getByText('보관된 Workspace에서는 답안을 제출할 수 없습니다.'),
    ).toBeInTheDocument();
    expect(client.openSession).not.toHaveBeenCalled();
  });

  it('sequence range step: 전체 선택 is tri-state and 시작 waits for a selection', async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      listRange: vi.fn(async () => ({
        ok: true as const,
        data: {
          chapters: [
            { id: 'c1', title: '1장 물', number: 1, question_count: 2, document_id: null },
          ],
          items: ['q1', 'q2'].map((id, i) => ({
            question_id: id,
            chapter_id: 'c1',
            question_number: i + 1,
            question_type: 'MCQ' as const,
            preview: `발문 ${i + 1} ( )`,
            status: 'unseen' as const,
            is_favorite: false,
            needs_retry: false,
            last_graded_result: null,
            is_pending_grading: false,
          })),
        },
      })),
    });
    render(
      <QuestionViewer
        mode="sequence"
        workspaceId={WS}
        state={{ step: 'picker', source: 'bank', mockExamId: null }}
        archived={false}
        onNavigate={noop}
        onClose={noop}
        client={client}
      />,
    );
    const panel = screen.getByRole('dialog', { name: '문제 풀기' });
    const all = await within(panel).findByRole('checkbox', { name: '전체 선택' });
    expect(within(panel).getByRole('button', { name: '시작' })).toBeDisabled();
    expect(within(panel).getByText('풀 문제를 고르세요')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: '1장 물 펼치기' }));
    const first = within(panel).getByRole('checkbox', { name: '1장 1번 · 발문 1 · 객관식' });
    await user.click(first);
    expect(all).toHaveAttribute('aria-checked', 'mixed');
    expect(within(panel).getByText('선택 1문제')).toBeInTheDocument();
    await user.click(all);
    expect(all).toHaveAttribute('aria-checked', 'true');
    expect(within(panel).getByRole('checkbox', { name: '무작위 순서' })).not.toBeChecked();
    await user.click(within(panel).getByRole('button', { name: '시작' }));
    await waitFor(() =>
      expect(client.create).toHaveBeenCalledWith({ all: true }, false, expect.any(String)),
    );
  });
});

describe('QVIEW-01-C06 call sites use QuestionViewer', () => {
  const src = (path: string) =>
    readFileSync(resolve(import.meta.dirname, '../src/components', path), 'utf8');

  it.each([
    ['questions/overview/questions-overview.tsx', 'mode="practice"'],
    ['questions/overview/questions-overview.tsx', 'mode="sequence"'],
    ['questions/detail/question-detail-dialog.tsx', 'mode="manage"'],
    ['shared/shared-questions.tsx', 'mode="read-only"'],
  ])('%s renders %s', (file, mode) => {
    expect(src(file)).toContain(mode);
  });

  it('keeps no other question panel implementation', () => {
    for (const file of [
      'questions/overview/questions-overview.tsx',
      'questions/detail/question-detail-dialog.tsx',
      'shared/shared-questions.tsx',
      'questions/inactive/inactive-questions.tsx',
    ]) {
      expect(src(file)).not.toMatch(/PracticePanel|RevisionView|<FloatingSidePanel/);
    }
  });
});
