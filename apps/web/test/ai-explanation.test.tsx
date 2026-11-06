// @vitest-environment jsdom
// AIEXPL-01 AI 해설 area (docs/screens/ai-explanations.md "레이아웃 및 컴포넌트", "화면 상태"): the
// view model, the relay client and stream parser, the area's states and actions, and where the
// QuestionViewer mounts it — never before a submission in `sequence` (answer leakage, AGENTS.md
// §5), with the position's submitted session as the gate.
import './dom-setup';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderWithToasts } from './render-with-toasts';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunClient } from '../src/components/questions/viewer/question-viewer';
import type {
  Explanation,
  ExplanationClient,
  ExplanationState,
} from '../src/lib/ai-explanations/client';
import type { PracticeSession, SubmitResult } from '../src/lib/questions/practice-actions';
import type { PracticeRun, RunItem } from '../src/lib/questions/practice-runs';

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
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { AiExplanation } = await import('../src/components/questions/ai-explanation/ai-explanation');
const { SharedAiExplanation } =
  await import('../src/components/questions/ai-explanation/shared-ai-explanation');
const { QuestionViewer } = await import('../src/components/questions/viewer/question-viewer');
const client = await import('../src/lib/ai-explanations/client');
const model = await import('../src/lib/ai-explanations/model');

const WS = '55555555-5555-4555-8555-555555555555';
const QID = '22222222-2222-4222-8222-000000000001';
const SESSION = '99999999-9999-4999-8999-000000000001';
const RUN = '33333333-3333-4333-8333-000000000001';
const PINNED = '88888888-8888-4888-8888-000000000009';
const OPTIONS = [
  { id: 'o1', text: '증발' },
  { id: 'o2', text: '응결' },
];

function explanation(overrides: Partial<Explanation> = {}): Explanation {
  return {
    id: '44444444-4444-4444-8444-000000000001',
    job_id: null,
    status: 'succeeded',
    version: 1,
    error_code: null,
    created_at: '2026-11-03T01:00:00Z',
    finished_at: '2026-11-03T01:00:05Z',
    body: {
      correct_option_ids: ['o1'],
      summary_md: '정답은 증발입니다. [1]',
      options: [
        { option_id: 'o1', why_md: '맞습니다.' },
        { option_id: 'o2', why_md: '틀립니다.' },
      ],
      concepts_md: '액체가 기체가 됩니다.',
      points_md: null,
    },
    sources: [
      {
        n: 1,
        document_id: '66666666-6666-4666-8666-000000000001',
        document_title: '물의 순환',
        chapter_title: '1장 물의 순환',
        page: 2,
        block_id: 'b-1',
        block_ids: ['b-1', 'b-2'],
        revision_id: PINNED,
        outdated: true,
      },
    ],
    truncated: false,
    question_revision_id: '77777777-7777-4777-8777-777777777777',
    ...overrides,
  } as Explanation;
}

function stateOf(overrides: Partial<ExplanationState> = {}): ExplanationState {
  return {
    available: true,
    can_create: true,
    can_regenerate: false,
    can_cancel: false,
    cancelled_id: null,
    explanation: null,
    ...overrides,
  };
}

function fakeClient(state: ExplanationState, created: ExplanationState = state) {
  return {
    state: vi.fn(async () => state),
    create: vi.fn(async () => created),
    regenerate: vi.fn(async () => created),
    cancel: vi.fn(async () => created),
    shared: vi.fn(async () => null),
  } satisfies ExplanationClient;
}

function area(scope: HTMLElement = document.body) {
  // The member view is a group (toolbar + the region once there is content); the shared one a region.
  return (
    within(scope).queryByRole('group', { name: 'AI 해설' }) ??
    within(scope).getByRole('region', { name: 'AI 해설' })
  );
}

const gate = { practice_session_id: SESSION } as const;
const target = { kind: 'question', id: QID } as const;

describe('AIEXPL-01 model', () => {
  it('maps failure codes and refusals to their reasons, never provider text', () => {
    expect(model.explanationErrorText('explanation_answer_mismatch')).toBe(
      '정답과 맞지 않는 해설이 나와 보여 주지 않았습니다. 다시 시도하세요.',
    );
    expect(model.explanationErrorText('llm_unavailable')).toBe(
      'AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.',
    );
    expect(model.explanationFailureText('rateLimited', 12)).toBe('잠시 후 다시 시도하세요 (12초)');
    expect(model.explanationFailureText('regenerateLimit')).toMatch(/더 다시 만들 수 없습니다/);
  });

  it('decides the empty state from the environment, then the archive', () => {
    expect(model.emptyMode({ available: true, can_create: true })).toBe('create');
    expect(model.emptyMode({ available: false, can_create: false })).toBe('disabled');
    expect(model.emptyMode({ available: true, can_create: false })).toBe('archived');
  });

  it('writes the source line and the version meta (only from version 2)', () => {
    const e = explanation();
    expect(model.sourceLine(e.sources[0] as (typeof e.sources)[number])).toBe(
      '[1] 물의 순환 · 1장 물의 순환 · p.2',
    );
    expect(model.metaText({ ...e, version: 1 }, () => 'T')).toBe('T');
    expect(model.metaText({ ...e, version: 3 }, () => 'T')).toBe('T · 버전 3');
  });
});

describe('AIEXPL-01 client', () => {
  it('classifies the problems the API sends', () => {
    expect(
      client.classifyExplanationFailure(409, { type: client.EXPLANATION_PROBLEMS.beforeSubmit }),
    ).toBe('beforeSubmit');
    expect(client.classifyExplanationFailure(429, { type: 'urn:x' })).toBe('rateLimited');
    expect(client.classifyExplanationFailure(404, {})).toBe('notFound');
    expect(
      client.classifyExplanationFailure(403, { type: client.EXPLANATION_PROBLEMS.archived }),
    ).toBe('archived');
  });

  it('puts the gate in the query for reads and in the body for writes', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(stateOf()));
    const api = client.createExplanationClient(fetchImpl);
    await api.state({ kind: 'mock', id: QID }, { mock_practice_session_id: SESSION });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `/api/mock-exam-questions/${QID}/ai-explanation?mock_practice_session_id=${SESSION}`,
    );
    await api.regenerate(target, { view: 'detail' });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(`/api/questions/${QID}/ai-explanation/regenerate`);
    expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe('{"view":"detail"}');
  });

  it('reads a stream until done (deltas, reset, the final explanation)', async () => {
    const done = explanation();
    const body = [
      'retry: 1000\n\n',
      'id: 1\nevent: delta\ndata: {"seq":0,"text":"가"}\n\n',
      'id: 2\nevent: reset\ndata: {}\n\n',
      'id: 3\nevent: delta\ndata: {"seq":0,"text":"나"}\n\n',
      `id: 4\nevent: done\ndata: ${JSON.stringify({ explanation: done })}\n\n`,
    ].join('');
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body));
    const events: string[] = [];
    const ids: number[] = [];
    const final = await client.readExplanationStream('question', done.id, gate, {
      signal: new AbortController().signal,
      fetchImpl,
      onId: (id) => ids.push(id),
      onEvent: (e) => events.push(e.type === 'delta' ? `delta:${e.text}` : e.type),
    });
    expect(final).toBe(true);
    expect(events).toEqual(['delta:가', 'reset', 'delta:나', 'done']);
    expect(ids).toEqual([1, 2, 3, 4]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `/api/ai-explanations/${done.id}/stream?practice_session_id=${SESSION}`,
    );
  });
});

describe('AIEXPL-01 area states', () => {
  it('none: 만들기 with the send notice; a double press makes one request and focuses the heading', async () => {
    const user = userEvent.setup();
    const api = fakeClient(stateOf(), stateOf({ explanation: explanation(), can_create: false }));
    render(
      <AiExplanation workspaceId={WS} target={target} gate={gate} options={OPTIONS} client={api} />,
    );
    const region = area();
    const button = await within(region).findByRole('button', { name: 'AI 해설' });
    expect(
      within(region).queryByText('문제와 정답, 관련 교재 구절이 AI 서비스로 전송됩니다.'),
    ).toBeNull();
    // No explanation yet: no area (region / heading) at all, only the button.
    expect(within(region).queryByRole('region')).toBeNull();
    expect(within(region).queryByRole('heading')).toBeNull();
    expect(within(region).queryByRole('status')).toBeNull();
    // The keyboard path (AIEXPL-01-AC06): Enter moves focus to the heading; a second press while
    // the request is out makes no second request.
    const pending: { answer?: (s: ExplanationState) => void } = {};
    api.create.mockImplementationOnce(
      () =>
        new Promise<ExplanationState>((resolve) => {
          pending.answer = resolve;
        }),
    );
    button.focus();
    await user.keyboard('{Enter}');
    fireEvent.click(button);
    pending.answer?.(stateOf({ explanation: explanation(), can_create: false }));
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledWith(target, gate);
    // The area mounts with the result; focus moves to its heading.
    expect(await within(region).findByRole('heading', { name: 'AI 해설', level: 3 })).toHaveFocus();
    // A cache hit: shown open at once, every option by its text and a footnote button.
    expect(await within(region).findByText('AI 생성')).toBeInTheDocument();
    expect(within(region).getByText('1. 증발')).toBeInTheDocument();
    expect(within(region).getByText('2. 응결')).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: '출처 1' })).toBeInTheDocument();
    expect(within(region).getByRole('list', { name: '출처' })).toHaveTextContent(
      '[1] 물의 순환 · 1장 물의 순환 · p.2',
    );
    expect(within(region).getByRole('heading', { name: 'AI 해설', level: 3 })).toHaveFocus();
  });

  it('UX10-AI-AC02 cached: open by default without making one', async () => {
    const user = userEvent.setup();
    const api = fakeClient(stateOf({ can_create: false, explanation: explanation() }));
    render(
      <AiExplanation workspaceId={WS} target={target} gate={gate} options={OPTIONS} client={api} />,
    );
    const show = await within(area()).findByRole('button', { name: 'AI 해설' });
    expect(show).toHaveAttribute('aria-expanded', 'true');
    expect(within(area()).getByRole('heading', { name: 'AI 해설', level: 3 })).toContainElement(
      show,
    );
    expect(within(area()).getByText('AI 생성')).toBeInTheDocument();
    expect(within(area()).queryByRole('button', { name: 'AI 해설 보기' })).toBeNull();
    await user.click(show);
    expect(show).toHaveAttribute('aria-expanded', 'false');
    expect(within(area()).queryByText('AI 생성')).toBeNull();
    expect(within(area()).queryByRole('button', { name: '다시 만들기' })).toBeNull();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('editors get 다시 만들기 (version meta), and its refusal reads as text', async () => {
    const user = userEvent.setup();
    const api = fakeClient(
      stateOf({
        can_create: false,
        can_regenerate: true,
        explanation: explanation({ version: 2 }),
      }),
    );
    api.regenerate.mockRejectedValueOnce(new client.ExplanationApiError('regenerateLimit', 409));
    render(
      <AiExplanation workspaceId={WS} target={target} gate={gate} options={OPTIONS} client={api} />,
    );
    await within(area()).findByRole('button', { name: 'AI 해설' });
    expect(within(area()).getByText(/· 버전 2$/)).toBeInTheDocument();
    await user.click(within(area()).getByRole('button', { name: '다시 만들기' }));
    expect(await within(area()).findByRole('alert')).toHaveTextContent(
      '오늘은 이 문제의 해설을 더 다시 만들 수 없습니다.',
    );
  });

  it('failed: one alert with the reason and 다시 시도 (a new generation)', async () => {
    const user = userEvent.setup();
    const failed = explanation({
      status: 'failed',
      body: null,
      sources: [],
      error_code: 'explanation_answer_mismatch',
    });
    const api = fakeClient(
      stateOf({ explanation: failed }),
      stateOf({ explanation: explanation(), can_create: false }),
    );
    render(
      <AiExplanation workspaceId={WS} target={target} gate={gate} options={OPTIONS} client={api} />,
    );
    expect(await within(area()).findByRole('alert')).toHaveTextContent(
      model.explanationErrorText('explanation_answer_mismatch'),
    );
    await user.click(within(area()).getByRole('button', { name: '다시 시도' }));
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(await within(area()).findByText('AI 생성')).toBeInTheDocument();
    expect(within(area()).queryByRole('alert')).toBeNull();
  });

  it('feature off shows nothing, archived the reason instead of a button', async () => {
    const off = fakeClient(stateOf({ available: false, can_create: false }));
    const { unmount } = render(
      <AiExplanation workspaceId={WS} target={target} gate={gate} options={OPTIONS} client={off} />,
    );
    await waitFor(() => expect(within(area()).queryByText(model.EXPL_TEXT.loading)).toBeNull());
    expect(within(area()).queryByText(model.EXPL_TEXT.disabled)).toBeNull();
    expect(within(area()).queryByRole('button')).toBeNull();
    unmount();
    const archived = fakeClient(stateOf({ can_create: false }));
    render(
      <AiExplanation
        workspaceId={WS}
        target={target}
        gate={gate}
        options={OPTIONS}
        client={archived}
      />,
    );
    expect(await within(area()).findByText(model.EXPL_TEXT.archived)).toBeInTheDocument();
  });
});

describe('AIEXPL-01 sources keep the pinned revision', () => {
  it('the excerpt reads the cited blocks of that revision and PDF에서 보기 opens it', async () => {
    const user = userEvent.setup();
    const api = fakeClient(stateOf({ can_create: false, explanation: explanation() }));
    const block = vi.fn(async (_doc: string, blockId: string, _revision: string) => ({
      block_id: blockId,
      text: `원래 구절 ${blockId}`,
      page: 2,
      locations: [],
    }));
    render(
      <AiExplanation
        workspaceId={WS}
        target={target}
        gate={gate}
        options={OPTIONS}
        client={api}
        searchClient={{ block } as never}
      />,
    );
    await within(area()).findByRole('button', { name: 'AI 해설' });
    await user.click(within(area()).getByRole('button', { name: '출처 1' }));
    const doc = '66666666-6666-4666-8666-000000000001';
    await waitFor(() => expect(block).toHaveBeenCalledWith(doc, 'b-1', PINNED));
    expect(block).toHaveBeenCalledWith(doc, 'b-2', PINNED);
    expect(block.mock.calls.every(([, , revision]) => revision === PINNED)).toBe(true);
    const excerpt = await screen.findByRole('dialog', { name: '본문 발췌' });
    expect(await within(excerpt).findByText(/원래 구절 b-1/)).toBeInTheDocument();
    expect(within(excerpt).getByText(model.EXPL_TEXT.outdated)).toBeInTheDocument();
    const link = within(excerpt).getByRole('link', { name: 'PDF에서 보기' });
    expect(
      new URL(link.getAttribute('href') ?? '', 'http://web.test').searchParams.get('revision'),
    ).toBe(PINNED);
  });
});

describe('AIEXPL-01 a failed stream ends the progress', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function sse(text: string) {
    return vi.fn<typeof fetch>(
      async () => new Response(text, { headers: { 'content-type': 'text/event-stream' } }),
    );
  }

  it('an error whose state cannot be read again shows the reason and 다시 시도', async () => {
    const user = userEvent.setup();
    const live = explanation({ status: 'running', body: null, sources: [], finished_at: null });
    globalThis.fetch = sse('id: 1\nevent: error\ndata: {"code":"llm_unavailable"}\n\n');
    const api = fakeClient(stateOf({ can_create: false, explanation: live }));
    api.state
      .mockResolvedValueOnce(stateOf({ can_create: false, explanation: live }))
      .mockRejectedValue(new client.ExplanationApiError('network'));
    render(
      <AiExplanation workspaceId={WS} target={target} gate={gate} options={OPTIONS} client={api} />,
    );
    const region = area();
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      model.explanationErrorText('llm_unavailable'),
    );
    expect(within(region).queryByText(model.EXPL_TEXT.working)).toBeNull();
    expect(region.querySelector('[aria-busy="true"]')).toBeNull();
    api.create.mockResolvedValueOnce(stateOf({ can_create: false, explanation: explanation() }));
    await user.click(within(region).getByRole('button', { name: '다시 시도' }));
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(await within(region).findByText('AI 생성')).toBeInTheDocument();
  });

  it('access lost mid-stream (not_found, then 404) shows the not-found reason, no retry', async () => {
    const live = explanation({ status: 'running', body: null, sources: [], finished_at: null });
    globalThis.fetch = sse('event: error\ndata: {"code":"not_found"}\n\n');
    const api = fakeClient(stateOf({ can_create: false, explanation: live }));
    api.state
      .mockResolvedValueOnce(stateOf({ can_create: false, explanation: live }))
      .mockRejectedValue(new client.ExplanationApiError('notFound', 404));
    render(
      <AiExplanation workspaceId={WS} target={target} gate={gate} options={OPTIONS} client={api} />,
    );
    const region = area();
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      model.explanationFailureText('notFound'),
    );
    expect(within(region).queryByText(model.EXPL_TEXT.working)).toBeNull();
    expect(within(region).queryByRole('button', { name: '다시 시도' })).toBeNull();
  });
});

describe('AIEXPL-01 streaming', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('shows the text as it streams (aria-busy) and announces the start and the end once each', async () => {
    const live = explanation({ status: 'running', body: null, sources: [], finished_at: null });
    const done = explanation({ id: live.id });
    const hold: { release?: () => void } = {};
    const gateOpen = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    globalThis.fetch = vi.fn<typeof fetch>(async () => {
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            enc.encode('id: 1\nevent: delta\ndata: {"seq":0,"text":"정답은 증발 [S1]"}\n\n'),
          );
          await gateOpen;
          controller.enqueue(
            enc.encode(`id: 2\nevent: done\ndata: ${JSON.stringify({ explanation: done })}\n\n`),
          );
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    });
    const api = fakeClient(stateOf({ can_create: false, explanation: live }));
    render(
      <AiExplanation workspaceId={WS} target={target} gate={gate} options={OPTIONS} client={api} />,
    );
    const region = area();
    expect((await within(region).findAllByText('작성중...')).length).toBeGreaterThan(0);
    expect(region.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await within(region).findByText(/정답은 증발/)).toBeInTheDocument();
    expect(within(region).getByRole('status')).toHaveTextContent('작성중...');
    api.state.mockResolvedValue(stateOf({ can_create: false, explanation: done }));
    hold.release?.();
    expect(await within(region).findByText('AI 생성')).toBeInTheDocument();
    expect(region.querySelector('[aria-busy="true"]')).toBeNull();
    expect(within(region).getByRole('status')).toHaveTextContent('AI 해설이 준비되었습니다');
  });
});

describe('UX12-EXPLCANCEL 취소', () => {
  const originalFetch = globalThis.fetch;
  const live = explanation({ status: 'running', body: null, sources: [], finished_at: null });
  const liveState = stateOf({ can_create: false, can_cancel: true, explanation: live });

  /** A stream that stays open, or sends `lines` and closes. */
  function stream(lines?: string) {
    globalThis.fetch = vi.fn<typeof fetch>(async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (lines) {
            controller.enqueue(new TextEncoder().encode(lines));
            controller.close();
          }
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
  }

  beforeEach(() => stream());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mount(api: ExplanationClient) {
    render(
      <AiExplanation workspaceId={WS} target={target} gate={gate} options={OPTIONS} client={api} />,
    );
  }

  it('a new one: 취소 beside 작성중..., then only the toolbar button, no alert', async () => {
    const user = userEvent.setup();
    const api = fakeClient(liveState, stateOf({ cancelled_id: live.id }));
    mount(api);
    const button = await within(area()).findByRole('button', { name: '취소' });
    expect(button.closest('div')).toHaveTextContent('작성중...');
    await user.click(button);
    expect(api.cancel).toHaveBeenCalledWith(target, gate, live.id);
    const create = await within(area()).findByRole('button', { name: 'AI 해설' });
    expect(create).toHaveFocus();
    expect(within(area()).queryByRole('region', { name: 'AI 해설' })).toBeNull();
    expect(within(area()).getByRole('status')).toHaveTextContent('취소했습니다');
    expect(within(area()).queryByRole('alert')).toBeNull();
  });

  it('a regeneration: back to the current one, with the focus on its heading', async () => {
    const user = userEvent.setup();
    const current = explanation({ id: '44444444-4444-4444-8444-000000000002' });
    const api = fakeClient(
      liveState,
      stateOf({
        can_create: false,
        can_regenerate: true,
        cancelled_id: live.id,
        explanation: current,
      }),
    );
    mount(api);
    await user.click(await within(area()).findByRole('button', { name: '취소' }));
    expect(await within(area()).findByText('AI 생성')).toBeInTheDocument();
    expect(within(area()).getByRole('heading', { name: 'AI 해설' })).toHaveFocus();
    expect(within(area()).getByRole('status')).toHaveTextContent('취소했습니다');
    expect(within(area()).queryByRole('alert')).toBeNull();
  });

  it('no 취소 without can_cancel', async () => {
    mount(fakeClient({ ...liveState, can_cancel: false }));
    expect((await within(area()).findAllByText('작성중...')).length).toBeGreaterThan(0);
    expect(within(area()).queryByRole('button', { name: '취소' })).toBeNull();
  });

  it('finished first: the result shows and reads as ready, not as cancelled', async () => {
    const user = userEvent.setup();
    const done = explanation({ id: live.id });
    const api = fakeClient(liveState, stateOf({ can_create: false, explanation: done }));
    mount(api);
    await user.click(await within(area()).findByRole('button', { name: '취소' }));
    expect(await within(area()).findByText('AI 생성')).toBeInTheDocument();
    expect(within(area()).getByRole('status')).toHaveTextContent('AI 해설이 준비되었습니다');
  });

  it('a stream that ends early and a failed regeneration: never announced as cancelled', async () => {
    stream('id: 1\nevent: delta\ndata: {"seq":0,"text":"일부"}\n\n');
    const current = explanation({ id: '44444444-4444-4444-8444-000000000002' });
    const api = fakeClient(
      stateOf({ can_create: false, can_regenerate: true, explanation: current }),
    );
    api.state.mockResolvedValueOnce(liveState);
    mount(api);
    expect(await within(area()).findByText('AI 생성')).toBeInTheDocument();
    expect(within(area()).getByRole('status')).not.toHaveTextContent('취소했습니다');
  });

  it('a stream that ends early after a cancel elsewhere: announced from the state', async () => {
    stream('id: 1\nevent: delta\ndata: {"seq":0,"text":"일부"}\n\n');
    const api = fakeClient(stateOf({ cancelled_id: live.id }));
    api.state.mockResolvedValueOnce({ ...liveState, can_cancel: false });
    mount(api);
    await waitFor(() =>
      expect(within(area()).getByRole('status')).toHaveTextContent('취소했습니다'),
    );
  });

  it('a regeneration that failed before the click is not announced as cancelled', async () => {
    const user = userEvent.setup();
    const current = explanation({ id: '44444444-4444-4444-8444-000000000002' });
    const api = fakeClient(
      liveState,
      stateOf({ can_create: false, can_regenerate: true, explanation: current }),
    );
    mount(api);
    await user.click(await within(area()).findByRole('button', { name: '취소' }));
    expect(await within(area()).findByText('AI 생성')).toBeInTheDocument();
    expect(within(area()).getByRole('status')).not.toHaveTextContent('취소했습니다');
  });

  it('a refused cancel says so and keeps the state', async () => {
    const user = userEvent.setup();
    const api = fakeClient(liveState);
    api.cancel.mockRejectedValueOnce(new client.ExplanationApiError('insufficientRole', 403));
    mount(api);
    await user.click(await within(area()).findByRole('button', { name: '취소' }));
    expect(await within(area()).findByRole('alert')).toHaveTextContent(
      model.EXPL_TEXT.cancelFailed,
    );
  });

  it('cancelled by someone else: the stream error shows nothing and no alert', async () => {
    stream('id: 1\nevent: error\ndata: {"code":"cancelled"}\n\n');
    const api = fakeClient(stateOf());
    api.state.mockResolvedValueOnce({ ...liveState, can_cancel: false });
    mount(api);
    await waitFor(() =>
      expect(within(area()).getByRole('status')).toHaveTextContent('취소했습니다'),
    );
    expect(await within(area()).findByRole('button', { name: 'AI 해설' })).toBeInTheDocument();
    expect(within(area()).queryByRole('alert')).toBeNull();
  });
});

describe('AIEXPL-01 client cancel', () => {
  it('names the explanation next to the gate', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(stateOf()), { status: 200 }),
    );
    await client.createExplanationClient(fetchImpl).cancel(target, gate, 'e-1');
    const [path, init] = fetchImpl.mock.calls[0] ?? [];
    expect(path).toBe(`/api/questions/${QID}/ai-explanation/cancel`);
    expect(JSON.parse(String(init?.body))).toEqual({ ...gate, explanation_id: 'e-1' });
  });
});

describe('AIEXPL-01 shared (guest)', () => {
  it('shows a read-only disclosure only when an explanation exists', async () => {
    const none = fakeClient(stateOf());
    const { container, unmount } = render(
      <SharedAiExplanation shareId={WS} questionId={QID} options={OPTIONS} client={none} />,
    );
    await waitFor(() => expect(none.shared).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();
    const found = explanation();
    const some = fakeClient(stateOf());
    some.shared.mockResolvedValue({
      body: found.body,
      sources: found.sources,
      created_at: found.created_at,
    } as never);
    render(<SharedAiExplanation shareId={WS} questionId={QID} options={OPTIONS} client={some} />);
    await screen.findByRole('region', { name: 'AI 해설' });
    expect(within(area()).getByRole('button', { name: 'AI 해설' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(area()).getByText('AI 생성')).toBeInTheDocument();
    for (const name of ['다시 만들기', '출처 1']) {
      expect(within(area()).queryByRole('button', { name })).toBeNull();
    }
    expect(within(area()).queryByText(/버전/)).toBeNull();
  });
});

// --- QuestionViewer `sequence`: mounted only after a submission ---------------------------------

function session(): PracticeSession {
  return {
    id: SESSION,
    workspace_id: WS,
    question_id: QID,
    question_revision_id: '77777777-7777-4777-8777-777777777777',
    question_number: 1,
    question_type: 'MCQ',
    chapter_id: null,
    stem: '물이 기체로 변하는 현상은?',
    is_multi_answer: false,
    displayed_option_ids: OPTIONS.map((o) => o.id),
    options: OPTIONS,
    state: 'open',
    opened_at: '2026-11-02T00:00:00Z',
  };
}

function runItem(): RunItem {
  return {
    position: 1,
    total: 1,
    available: true,
    question_id: QID,
    question_type: 'MCQ',
    chapter_id: null,
    chapter_number: 1,
    chapter_title: '1장',
    question_number: 1,
    stem: '물이 기체로 변하는 현상은?',
    is_multi_answer: false,
    options: OPTIONS,
    practice_session_id: null,
    session_state: null,
    attempt: null,
  };
}

const RUN_DATA: PracticeRun = {
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
};

const GRADED: SubmitResult = {
  attempt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  practice_session_id: SESSION,
  question_revision_id: session().question_revision_id,
  state: 'graded',
  result: 'correct',
  correct_option_ids: ['o1'],
  accepted_answers: null,
  explanation: '사람이 쓴 해설',
  rubric: null,
};

describe('AIEXPL-01 in QuestionViewer sequence', () => {
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(() => {
    fetchSpy = vi.fn<typeof fetch>(async () => Response.json(stateOf()));
    globalThis.fetch = fetchSpy;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reads nothing before the submission, then asks with the position session as the gate', async () => {
    const user = userEvent.setup();
    const runClient = {
      listRange: vi.fn(),
      create: vi.fn(),
      getRun: vi.fn(async () => ({ ok: true as const, data: RUN_DATA })),
      getItem: vi.fn(async () => ({ ok: true as const, data: runItem() })),
      openSession: vi.fn(async () => ({ ok: true as const, data: session() })),
      submit: vi.fn(async () => ({ ok: true as const, data: GRADED })),
      selfGrade: vi.fn(),
      finish: vi.fn(),
      results: vi.fn(),
    } as unknown as RunClient;
    renderWithToasts(
      <QuestionViewer
        mode="sequence"
        workspaceId={WS}
        state={{ step: 'solve', runId: RUN, position: 1 }}
        archived={false}
        onNavigate={() => undefined}
        onClose={() => undefined}
        client={runClient}
      />,
    );
    const panel = screen.getByRole('dialog');
    await user.click(await within(panel).findByRole('radio', { name: '증발' }));
    expect(within(panel).queryByRole('region', { name: 'AI 해설' })).toBeNull();
    const explanationCalls = () =>
      fetchSpy.mock.calls.filter(([url]) => String(url).includes('ai-explanation'));
    expect(explanationCalls()).toEqual([]);
    await user.click(within(panel).getByRole('button', { name: /^제출$/ }));
    expect(await within(panel).findByRole('button', { name: 'AI 해설' })).toBeInTheDocument();
    expect(explanationCalls().map(([url]) => url)).toEqual([
      `/api/questions/${QID}/ai-explanation?practice_session_id=${SESSION}`,
    ]);
  });
});
