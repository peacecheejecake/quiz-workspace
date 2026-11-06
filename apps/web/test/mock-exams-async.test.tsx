// @vitest-environment jsdom
// MOCK-W review follow-ups (Codex P2s): the mock exam dialog's async edges.
//   - A mock run's session routing survives the run client being replaced (a reload learns the
//     run's mock exam after the first item read, which recreates the client).
//   - 설정 바꾸기 sends the saved range intent back unchanged unless the range was changed.
//   - 만들기 that answers after the user left the form never navigates; its idempotency key is
//     kept for retries of the same opening, retired by its own success, fresh for a new opening.
import './dom-setup';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MockExamApi,
  MockResult,
} from '../src/components/questions/mock-exams/mock-exam-client';
import type { MockExam } from '../src/components/questions/mock-exams/mock-exam-model';

vi.mock('../src/lib/questions/practice-actions', () => ({
  submitPracticeAction: vi.fn(),
  selfGradePracticeAction: vi.fn(async () => ({ ok: false, kind: 'notFound', message: 'bank' })),
  setMyStateAction: vi.fn(),
  lookupOverviewQuestionAction: vi.fn(),
}));
vi.mock('../src/lib/questions/actions', () => ({
  getQuestionAction: vi.fn(),
  getQuestionRevisionAction: vi.fn(),
}));

const { homeRunClient } = await import('../src/components/questions/mock-exams/mock-run');
const { MockExamForm } = await import('../src/components/questions/mock-exams/mock-exam-form');
const { MockExamsPanel } = await import('../src/components/questions/mock-exams/mock-exams-panel');

const WS = '55555555-5555-4555-8555-555555555555';
const RUN = '33333333-3333-4333-8333-000000000009';
const SESSION = '99999999-9999-4999-8999-000000000009';
const EXAM = '44444444-4444-4444-8444-000000000009';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mock run session routing', () => {
  it('self-grades a pending mock session through the mock route after the client is replaced', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith(`/practice-runs/${RUN}`)) {
        return json({
          id: RUN,
          workspace_id: WS,
          source: 'mock',
          mock_exam_id: EXAM,
          random_order: false,
          shuffle_options: false,
          seed: 1,
          total: 1,
          answered: 1,
          reached: 1,
          created_at: '2026-11-02T00:00:00Z',
          finished_at: null,
          summary: { correct: 0, incorrect: 0, pending: 1, skipped: 0 },
        });
      }
      if (url.includes(`/practice-runs/${RUN}/items/1`)) {
        return json({ position: 1, total: 1, available: true, practice_session_id: SESSION });
      }
      if (url.endsWith(`/mock-practice-sessions/${SESSION}/self-grade`)) {
        return json({
          attempt_id: 'a',
          grades_attempt_id: 'b',
          practice_session_id: SESSION,
          result: 'correct',
        });
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchImpl);

    // The reload's first client (the run's mock exam not known yet) reads the item…
    const first = homeRunClient(WS, null, fetchImpl);
    expect((await first.getItem(RUN, 1)).ok).toBe(true);
    // …then the run is known and the panel gets a new client, which grades.
    const second = homeRunClient(WS, EXAM, fetchImpl);
    const graded = await second.selfGrade(SESSION, 'correct');
    expect(graded.ok).toBe(true);
    expect(calls.some((u) => u.endsWith(`/mock-practice-sessions/${SESSION}/self-grade`))).toBe(
      true,
    );
  });

  it('UX12-CHAPTERRUN-AC07 the home client passes 보기 섞기 on to a bank run', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json({ id: RUN, workspace_id: WS, source: 'bank', mock_exam_id: null }, 201);
      }),
    );
    const created = await homeRunClient(WS, null).create({ all: true }, true, 'key', true);
    expect(created.ok).toBe(true);
    expect(bodies).toEqual([
      expect.objectContaining({ random_order: true, shuffle_options: true }),
    ]);
  });
});

const C1 = '11111111-1111-4111-8111-000000000001';
const Q = (n: number) => `22222222-2222-4222-8222-00000000000${n}`;

function overview() {
  return {
    chapters: [{ id: C1, title: '1장 물의 순환', number: 1, question_count: 3, document_id: null }],
    items: [1, 2, 3].map((n) => ({
      question_id: Q(n),
      chapter_id: C1,
      question_number: n,
      question_type: 'MCQ',
      preview: `발문 ${n}`,
      status: 'unseen',
      is_favorite: false,
      needs_retry: false,
      is_pending_grading: false,
      last_graded_result: null,
    })),
    counts: {},
  };
}

describe('설정 바꾸기 keeps the saved range intent', () => {
  it.each([
    [
      'single questions that happen to cover everything',
      {
        all: false,
        chapter_ids: [],
        question_ids: [Q(1), Q(2), Q(3)],
        excluded_question_ids: [],
      },
    ],
    [
      '전체 선택 with an exclusion',
      { all: true, chapter_ids: [], question_ids: [], excluded_question_ids: [Q(2)] },
    ],
  ])('sends %s back as it was when only the options change', async (_name, saved) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(overview())),
    );
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <MockExamForm
        workspaceId={WS}
        mode="settings"
        initial={{
          title: '중간 점검',
          types: ['PARAPHRASE'],
          count: '2',
          wholeRange: false,
          difficulty: null,
        }}
        initialRange={saved}
        llmAvailable
        busy={false}
        error={null}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole('button', { name: '다음' }));
    const remake = screen.getByRole('button', { name: '다시 만들기' });
    await waitFor(() => expect(remake).toBeEnabled());
    await user.click(remake);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0].range).toEqual(saved);
  });
  it('UX10-AI-AC01 normalizes saved AI types when the LLM is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(overview())),
    );
    render(
      <MockExamForm
        workspaceId={WS}
        mode="settings"
        initial={{
          title: '중간 점검',
          types: ['PARAPHRASE'],
          count: '3',
          wholeRange: false,
          difficulty: null,
        }}
        initialRange={{ all: true, chapter_ids: [], question_ids: [], excluded_question_ids: [] }}
        llmAvailable={false}
        busy={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole('checkbox', { name: /보기 섞기/ })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /발문/ })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: '다음' }));
    expect(await screen.findByRole('button', { name: '다시 만들기' })).toBeInTheDocument();
  });
});

function exam(id: string): MockExam {
  return {
    id,
    workspace_id: WS,
    title: '중간 점검',
    version: 1,
    status: 'generating',
    config: { variation_types: ['OPTION_SHUFFLE'], question_count: 1 },
    range: { all: true, chapter_ids: [], question_ids: [], excluded_question_ids: [] },
    question_count_current: 0,
    current_generation: null,
    latest_generation: null,
    created_at: '2026-11-02T00:00:00Z',
    updated_at: '2026-11-02T00:00:00Z',
  };
}

describe('만들기 after leaving the form', () => {
  it('does not navigate when the user went back to the list meanwhile, and keys follow the opening', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(overview())),
    );
    const pending: { key: string; answer: ReturnType<typeof deferred<MockResult<MockExam>>> }[] =
      [];
    const api: MockExamApi = {
      list: async () => ({ ok: true, data: { llm_available: false, items: [] } }),
      get: async () => ({ ok: true, data: exam(EXAM) }),
      create: (_body, key) => {
        const answer = deferred<MockResult<MockExam>>();
        pending.push({ key, answer });
        return answer.promise;
      },
      regenerate: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      questions: async () => ({ ok: true, data: [] }),
      editQuestion: vi.fn(),
      removeQuestion: vi.fn(),
    };
    const onViewChange = vi.fn();
    const props = {
      open: true,
      onOpenChange: () => undefined,
      container: null,
      workspaceId: WS,
      canEdit: true,
      onViewChange,
      onPractise: () => undefined,
      onBankStarted: () => undefined,
      api,
    };
    const user = userEvent.setup();
    const { rerender } = render(<MockExamsPanel {...props} view={{ view: 'create' }} />);
    async function make() {
      await user.click(await screen.findByRole('checkbox', { name: /보기 섞기/ }));
      await user.click(screen.getByRole('checkbox', { name: '선택 범위의 모든 문항' }));
      await user.click(await screen.findByRole('button', { name: '다음' }));
      await user.click(await screen.findByRole('checkbox', { name: '전체 선택' }));
      await user.click(screen.getByRole('button', { name: '만들기' }));
    }

    // An ambiguous failure keeps the key: the retry of the same opening reuses it.
    await make();
    await act(async () =>
      pending[0]?.answer.resolve({ ok: false, kind: 'unavailable', message: 'x' }),
    );
    await user.click(screen.getByRole('button', { name: '만들기' }));
    expect(pending[1]?.key).toBe(pending[0]?.key);

    // The user leaves for the list before the answer: no navigation back to a detail.
    rerender(<MockExamsPanel {...props} view={{ view: 'list' }} />);
    await act(async () => pending[1]?.answer.resolve({ ok: true, data: exam(EXAM) }));
    expect(onViewChange).not.toHaveBeenCalledWith(
      { view: 'detail', mockExamId: EXAM },
      expect.anything(),
    );

    // A new opening gets a new key.
    rerender(<MockExamsPanel {...props} view={{ view: 'create' }} />);
    await make();
    expect(pending[2]?.key).not.toBe(pending[0]?.key);
    await act(async () => pending[2]?.answer.resolve({ ok: true, data: exam(EXAM) }));
    expect(onViewChange).toHaveBeenCalledWith({ view: 'detail', mockExamId: EXAM }, 'replace');
  });
});

describe('UX10-PLAY-AC01 unified bank mode', () => {
  it('keeps empty types with AI off and starts all selected questions as bank without mock config', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(overview())),
    );
    const onBankSubmit = vi.fn();
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <MockExamForm
        workspaceId={WS}
        mode="create"
        initial={{ title: '풀이', types: [], count: '10', wholeRange: true, difficulty: null }}
        llmAvailable={false}
        busy={false}
        error={null}
        onSubmit={onSubmit}
        onBankSubmit={onBankSubmit}
      />,
    );
    expect(screen.getByRole('checkbox', { name: /보기 섞기/ })).not.toBeChecked();
    expect(screen.queryByRole('progressbar')).toBeNull();
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.click(await screen.findByRole('checkbox', { name: '전체 선택' }));
    await user.click(screen.getByRole('button', { name: '시작' }));
    expect(onBankSubmit).toHaveBeenCalledWith(expect.objectContaining({ all: true }), null, false);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

it('UX10-PLAY-AC01 preserves other URL state in the bank fallback', async () => {
  const { bankRunLocation } =
    await import('../src/components/questions/mock-exams/mock-exams-panel');
  const target = bankRunLocation(
    '/workspaces/w',
    '?status=incorrect&panel=mock-exams&mock=new',
    RUN,
  );
  const url = new URL(target, 'http://localhost');
  expect(url.searchParams.get('status')).toBe('incorrect');
  expect(url.searchParams.get('panel')).toBeNull();
  expect(url.searchParams.get('mock')).toBeNull();
  expect(url.searchParams.get('practice')).toBe(RUN);
  expect(url.searchParams.get('i')).toBe('1');
});

it('UX10-PLAY-AC01 invokes the supplied bank navigation callback after creation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return json({ id: RUN, workspace_id: WS });
      return json(overview());
    }),
  );
  const api = { list: async () => ({ ok: true, data: { llm_available: false, items: [] } }) };
  const onBankStarted = vi.fn();
  const user = userEvent.setup();
  render(
    <MockExamsPanel
      open
      onOpenChange={() => undefined}
      container={null}
      workspaceId={WS}
      canEdit
      view={{ view: 'create' }}
      onViewChange={() => undefined}
      onPractise={() => undefined}
      onBankStarted={onBankStarted}
      api={api as never}
    />,
  );
  await user.click(await screen.findByRole('checkbox', { name: '선택 범위의 모든 문항' }));
  await user.click(screen.getByRole('button', { name: '다음' }));
  await user.click(await screen.findByRole('checkbox', { name: '전체 선택' }));
  await user.click(screen.getByRole('button', { name: '시작' }));
  await waitFor(() => expect(onBankStarted).toHaveBeenCalledWith(RUN));
});
