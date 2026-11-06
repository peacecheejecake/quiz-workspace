// @vitest-environment jsdom
// MOCK-W review follow-ups (Codex P2s): the mock exam dialog's async edges.
//   - A mock run's session routing survives the run client being replaced (a reload learns the
//     run's mock exam after the first item read, which recreates the client).
//   - 설정 바꾸기 sends the saved range intent back unchanged unless the range was changed.
//   - 만들기 that answers after the user left the form never navigates; its idempotency key is
//     kept for retries of the same opening, retired by its own success, fresh for a new opening.
import './dom-setup';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
    const next = screen.getByRole('button', { name: '다음' });
    await waitFor(() => expect(next).toBeEnabled());
    await user.click(next);
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
    const next = screen.getByRole('button', { name: '다음' });
    await waitFor(() => expect(next).toBeEnabled());
    await userEvent.setup().click(next);
    expect(screen.getByRole('checkbox', { name: /보기 섞기/ })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /문구 변형/ })).toBeNull();
    expect(screen.queryByText(/이 환경에서는 AI 변형을/)).toBeNull();
    expect(await screen.findByRole('button', { name: '다시 만들기' })).toBeInTheDocument();
  });
});

describe('UX12-MOCKFORM2 범위 first', () => {
  const C2 = '11111111-1111-4111-8111-000000000002';
  function twoChapters() {
    const base = overview();
    return {
      ...base,
      chapters: [
        ...base.chapters,
        { id: C2, title: '2장 정수 처리', number: 2, question_count: 1, document_id: null },
      ],
      items: base.items.map((item, i) => (i === 2 ? { ...item, chapter_id: C2 } : item)),
    };
  }
  function create(onSubmit = vi.fn()) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(twoChapters())),
    );
    render(
      <MockExamForm
        workspaceId={WS}
        mode="create"
        initial={{
          title: '모의고사 1',
          types: [],
          count: '20',
          wholeRange: false,
          difficulty: null,
        }}
        llmAvailable
        busy={false}
        error={null}
        onSubmit={onSubmit}
        onBankSubmit={vi.fn()}
      />,
    );
    return { user: userEvent.setup(), onSubmit };
  }
  const chapter = (name: RegExp) => screen.findByRole('checkbox', { name });

  it('AC01 starts on 범위: 다음 waits for a selection and the last step holds the action', async () => {
    const { user } = create();
    await chapter(/^1장 물의 순환/);
    const next = screen.getByRole('button', { name: '다음' });
    expect(next).toBeDisabled();
    expect(next).toHaveAccessibleDescription('출제 범위를 고르세요');
    expect(screen.queryByRole('checkbox', { name: /보기 섞기/ })).toBeNull();
    expect(screen.queryByText(/문항을 만듭니다/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^(만들기|시작)$/ })).toBeNull();

    await user.click(await chapter(/^1장 물의 순환/));
    expect(screen.getByText('선택 2문제')).toBeInTheDocument();
    await user.click(next);

    expect(screen.getByRole('heading', { name: '옵션' })).toHaveFocus();
    expect(screen.getByRole('button', { name: '시작' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '다음' })).toBeNull();
    expect(screen.queryByRole('button', { name: '이전' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: /문구 변형/ }));
    expect(screen.getByRole('button', { name: '만들기' })).toBeInTheDocument();
    expect(screen.getByText(/AI 서비스로 전송됩니다/)).toBeInTheDocument();
    expect(screen.getByText('선택 2문제 중 2문항을 만듭니다')).toBeInTheDocument();
  });

  it('AC02 names the exam after the chapters until the name is edited', async () => {
    const { user } = create();
    await user.click(await chapter(/^1장 물의 순환/));
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.click(screen.getByRole('checkbox', { name: /문구 변형/ }));
    expect(screen.getByRole('textbox', { name: /이름/ })).toHaveValue('1장 물의 순환');

    // Not edited: the name follows a changed range.
    const back = () => screen.getByRole('button', { name: '범위 단계로 돌아가기' });
    await user.click(back());
    await user.click(await chapter(/^2장 정수 처리/));
    await user.click(await chapter(/^1장 물의 순환/));
    await user.click(screen.getByRole('button', { name: '다음' }));
    expect(screen.getByRole('textbox', { name: /이름/ })).toHaveValue('2장 정수 처리');

    // Edited: never again, even with the range changed.
    await user.type(screen.getByRole('textbox', { name: /이름/ }), ' 복습');
    await user.click(back());
    await user.click(await chapter(/^1장 물의 순환/));
    await user.click(screen.getByRole('button', { name: '다음' }));
    expect(screen.getByRole('textbox', { name: /이름/ })).toHaveValue('2장 정수 처리 복습');
  });

  it('AC02 keeps the default name for 전체 선택 and the saved name in 설정 바꾸기', async () => {
    const { user } = create();
    await user.click(await screen.findByRole('checkbox', { name: '전체 선택' }));
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.click(screen.getByRole('checkbox', { name: /문구 변형/ }));
    expect(screen.getByRole('textbox', { name: /이름/ })).toHaveValue('모의고사 1');
    cleanup();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(twoChapters())),
    );
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
        initialRange={{
          all: false,
          chapter_ids: [C1],
          question_ids: [],
          excluded_question_ids: [],
        }}
        llmAvailable
        busy={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    );
    const next = screen.getByRole('button', { name: '다음' });
    await waitFor(() => expect(next).toBeEnabled());
    await user.click(next);
    expect(screen.getByRole('textbox', { name: /이름/ })).toHaveValue('중간 점검');
    expect(screen.getByRole('spinbutton', { name: /문항 수/ })).toHaveValue(2);
  });

  it('AC03 drops the three notes', async () => {
    const { user } = create();
    await user.click(await screen.findByRole('checkbox', { name: '전체 선택' }));
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.click(screen.getByRole('checkbox', { name: /보기 섞기/ }));
    expect(screen.getByRole('checkbox', { name: '선택 범위의 모든 문항' })).toBeInTheDocument();
    expect(screen.queryByText(/선택 범위까지 풀 수 있습니다/)).toBeNull();
    expect(screen.queryByText(/난이도는 원본과 같습니다/)).toBeNull();
    expect(screen.queryByText(/선택한 범위의 문제를 모두 사용합니다/)).toBeNull();
  });

  it('AC04 has one help button whose Popover opens by press and gathers every type', async () => {
    const { user } = create();
    await user.click(await screen.findByRole('checkbox', { name: '전체 선택' }));
    await user.click(screen.getByRole('button', { name: '다음' }));
    expect(screen.getByRole('group', { name: '변형 유형' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: / 설명$/ })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '변형 유형 설명' }));
    const help = await screen.findByRole('dialog', { name: '변형 유형 설명' });
    expect(help).toHaveTextContent('보기 순서만 섞습니다');
    expect(help).toHaveTextContent('문제 문구를 바꿉니다');
    expect(help).toHaveTextContent("'옳은 것'을 묻도록 뒤집습니다");
    expect(help).toHaveTextContent('비슷한 개념을 묻는 문제를 만듭니다');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: '변형 유형 설명' })).toHaveFocus();
  });

  it('AC06 checks the options at the last action, Enter included', async () => {
    const { user, onSubmit } = create();
    await user.click(await screen.findByRole('checkbox', { name: '전체 선택' }));
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.click(screen.getByRole('checkbox', { name: /문구 변형/ }));
    const name = screen.getByRole('textbox', { name: /이름/ });
    await user.clear(name);
    await user.click(screen.getByRole('button', { name: '만들기' }));
    expect(screen.getByText('이름을 입력하세요.')).toBeInTheDocument();
    expect(name).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(name, '점검{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0].title).toBe('점검');
    expect(onSubmit.mock.calls[0]?.[0].config.question_count).toBe(3);
  });

  it('AC06 starts 문항 수 at the selection and never overwrites a typed one', async () => {
    const { user } = create();
    await user.click(await chapter(/^1장 물의 순환/));
    await user.click(screen.getByRole('button', { name: '다음' }));
    const count = () => screen.getByRole('spinbutton', { name: /문항 수/ });
    expect(count()).toHaveValue(2);
    expect(screen.getByRole('button', { name: '시작' })).toBeEnabled();

    await user.clear(count());
    await user.type(count(), '5');
    const start = screen.getByRole('button', { name: '시작' });
    expect(start).toBeDisabled();
    expect(start).toHaveAccessibleDescription('선택한 범위보다 문항 수가 많습니다.');
    await user.click(screen.getByRole('button', { name: '범위 단계로 돌아가기' }));
    await user.click(screen.getByRole('button', { name: '다음' }));
    expect(count()).toHaveValue(5);
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
      await user.click(await screen.findByRole('checkbox', { name: '전체 선택' }));
      await user.click(screen.getByRole('button', { name: '다음' }));
      await user.click(screen.getByRole('checkbox', { name: /보기 섞기/ }));
      await user.click(screen.getByRole('checkbox', { name: '선택 범위의 모든 문항' }));
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
    expect(screen.queryByRole('progressbar')).toBeNull();
    await user.click(await screen.findByRole('checkbox', { name: '전체 선택' }));
    await user.click(screen.getByRole('button', { name: '다음' }));
    expect(screen.getByRole('checkbox', { name: /보기 섞기/ })).not.toBeChecked();
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
  await user.click(await screen.findByRole('checkbox', { name: '전체 선택' }));
  await user.click(screen.getByRole('button', { name: '다음' }));
  await user.click(screen.getByRole('checkbox', { name: '선택 범위의 모든 문항' }));
  await user.click(screen.getByRole('button', { name: '시작' }));
  await waitFor(() => expect(onBankStarted).toHaveBeenCalledWith(RUN));
});
