// @vitest-environment jsdom
// QGEN-MULTI: batch model helpers, the problem mapping of the batch API, the bank's selection
// (CONFIRMED only, editors only, ≤ 20, one batch request with the selected ids) and the batch
// results page (progress, one group per source, review links that keep the batch).
import './dom-setup';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@quiz/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FILTERS } from '../src/lib/questions/filters';
import type { Question } from '../src/lib/questions/form';
import {
  batchPath,
  classifyGenerationFailure,
  generatePath,
  type GenerationBatch,
  type GenerationRun,
} from '../src/lib/questions/generation-client';
import {
  batchCostProblem,
  batchItemStatus,
  batchProgress,
  DEFAULT_RANDOM_FILTERS,
  MAX_BATCH_SOURCES,
  randomSelection,
  toggleSource,
} from '../src/lib/questions/generation-model';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/workspaces/ws/questions/bank',
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../src/lib/questions/actions', () => ({
  listQuestionsAction: vi.fn(),
  deleteQuestionAction: vi.fn(),
  setQuestionStatusAction: vi.fn(),
  createQuestionAction: vi.fn(),
  updateQuestionAction: vi.fn(),
  getQuestionAction: vi.fn(),
  getQuestionRevisionAction: vi.fn(),
}));

const { QuestionBank } = await import('../src/components/questions/question-bank');
const { GenerationBatchView } =
  await import('../src/components/questions/generate/generation-batch');

const WS = '55555555-5555-4555-8555-555555555555';
const BATCH = '66666666-6666-4666-8666-666666666666';

function q(n: number, status: Question['publication_status'] = 'CONFIRMED'): Question {
  return {
    id: `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`,
    workspace_id: WS,
    question_type: 'MCQ',
    publication_status: status,
    origin: 'manual',
    chapter_id: null,
    chapter: null,
    question_number: n,
    revision: {
      id: `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`,
      version: 1,
      stem: `문제 ${n}`,
      options: [],
      correct_option_ids: null,
      accepted_answers: null,
      is_multi_answer: false,
      explanation: null,
      rubric: null,
      created_at: '2026-10-17T00:00:00Z',
    },
    sources: [],
    created_at: '2026-10-17T00:00:00Z',
    updated_at: '2026-10-17T00:00:00Z',
  };
}

function run(n: number, overrides: Partial<GenerationRun> = {}): GenerationRun {
  return {
    id: `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`,
    workspace_id: WS,
    status: 'succeeded',
    job_id: null,
    error_code: null,
    source_question_id: q(n).id,
    source_question_revision_id: q(n).revision.id,
    variation_types: ['PARAPHRASE'],
    candidate_count: 1,
    difficulty: null,
    draft_count: 1,
    published_count: 0,
    llm_model: null,
    prompt_version: null,
    batch_id: BATCH,
    created_at: '2026-10-23T00:00:00Z',
    updated_at: '2026-10-23T00:00:00Z',
    finished_at: null,
    ...overrides,
  };
}

function batch(runs: GenerationRun[], overrides: Partial<GenerationBatch> = {}): GenerationBatch {
  const working = runs.filter((r) => r.status === 'queued' || r.status === 'running').length;
  return {
    id: BATCH,
    workspace_id: WS,
    mode: 'selected',
    seed: null,
    requested_count: runs.length,
    status: working ? 'working' : 'finished',
    run_count: runs.length,
    finished_run_count: runs.length - working,
    draft_count: runs.reduce((n, r) => n + r.draft_count, 0),
    published_count: runs.reduce((n, r) => n + r.published_count, 0),
    created_at: '2026-10-23T00:00:00Z',
    items: runs.map((r, i) => ({
      position: i,
      source: {
        question_id: r.source_question_id,
        question_number: i + 1,
        preview: `원본 ${i + 1}`,
      },
      run: r,
    })),
    ...overrides,
  };
}

describe('batch model', () => {
  it('toggles sources in order and never past the cap', () => {
    expect(toggleSource(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleSource(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(toggleSource(['a'], 'a', true)).toEqual(['a']);
    const full = Array.from({ length: MAX_BATCH_SOURCES }, (_, i) => `q${i}`);
    expect(toggleSource(full, 'extra', true)).toEqual(full);
  });

  it('guards the candidate cost like the API', () => {
    expect(
      batchCostProblem(20, { variation_types: ['PARAPHRASE'], candidate_count: 3 }),
    ).toBeNull();
    expect(
      batchCostProblem(20, {
        variation_types: ['PARAPHRASE', 'INVERT_POLARITY'],
        candidate_count: 2,
      }),
    ).toMatch(/60개까지/);
  });

  it('builds the random selection from the filters', () => {
    expect(randomSelection(DEFAULT_RANDOM_FILTERS)).toEqual({ mode: 'random', count: 5 });
    expect(
      randomSelection({
        count: '3',
        chapter: 'none',
        questionType: 'MCQ',
        statuses: ['retry', 'unseen'],
        favoriteOnly: true,
      }),
    ).toEqual({
      mode: 'random',
      count: 3,
      chapter: 'none',
      question_type: 'MCQ',
      statuses: ['unseen', 'retry'],
      favorite: true,
    });
    for (const count of ['0', '21', 'abc', '']) {
      expect(randomSelection({ ...DEFAULT_RANDOM_FILTERS, count })).toBeNull();
    }
  });

  it('reports progress and per-source states', () => {
    const b = batch([run(1), run(2, { status: 'running', draft_count: 0 })]);
    expect(batchProgress(b)).toBe(50);
    expect(batchItemStatus(run(1))).toBe('초안 1개');
    expect(batchItemStatus(run(1, { published_count: 1 }))).toBe('초안 1개 · 등록 1개');
    expect(batchItemStatus(run(1, { status: 'queued' }))).toBe('대기 중');
    expect(batchItemStatus(run(1, { status: 'failed' }))).toBe('실패');
  });

  it('maps the batch problems and builds batch paths', () => {
    expect(classifyGenerationFailure(429, {})).toBe('rateLimited');
    expect(
      classifyGenerationFailure(409, { type: 'urn:quiz-workspace:problem:generation-busy' }),
    ).toBe('generationBusy');
    expect(
      classifyGenerationFailure(409, { type: 'urn:quiz-workspace:problem:no-matching-questions' }),
    ).toBe('noMatchingQuestions');
    expect(batchPath(WS, BATCH)).toBe(`/workspaces/${WS}/questions/generate?batch=${BATCH}`);
    expect(generatePath(WS, 'q', 'r', BATCH)).toBe(
      `/workspaces/${WS}/questions/generate?source=q&run=r&batch=${BATCH}`,
    );
  });
});

describe('QuestionBank batch selection', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    push.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  function Bank({ items, readOnly = null }: { items: Question[]; readOnly?: 'viewer' | null }) {
    return (
      <ToastProvider>
        <QuestionBank
          workspaceId={WS}
          readOnly={readOnly}
          failure={null}
          chapters={[]}
          documents={[]}
          filters={DEFAULT_FILTERS}
          items={items}
          nextCursor={null}
        />
      </ToastProvider>
    );
  }

  it('selects CONFIRMED questions and starts one batch with their ids', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(batch([run(1), run(3)])), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    render(<Bank items={[q(1), q(2, 'DRAFT'), q(3)]} />);
    expect(screen.queryByRole('checkbox', { name: '2번 문제 선택' })).toBeNull();
    expect(screen.queryByRole('region', { name: '선택한 문제' })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: '1번 문제 선택' }));
    await user.click(screen.getByRole('checkbox', { name: '3번 문제 선택' }));
    const bar = screen.getByRole('region', { name: '선택한 문제' });
    expect(bar).toHaveTextContent('2개 선택됨');
    await user.click(within(bar).getByRole('button', { name: '선택한 문제 변형 출제 (2)' }));

    const dialog = await screen.findByRole('dialog', { name: '선택한 문제 변형 출제 (2)' });
    expect(within(dialog).queryByRole('checkbox', { name: /보기 섞기/ })).toBeNull();
    await user.click(within(dialog).getByRole('checkbox', { name: /문구 변형/ }));
    await user.click(within(dialog).getByRole('button', { name: '생성' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith(batchPath(WS, BATCH)));
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/workspaces/${WS}/question-generation-batches`);
    expect(JSON.parse(String(init?.body))).toEqual({
      variation_types: ['PARAPHRASE'],
      candidate_count: 1,
      selection: { mode: 'selected', question_ids: [q(1).id, q(3).id] },
    });
    expect(new Headers(init?.headers).get('idempotency-key')).toBeTruthy();
  });

  it('caps the selection at 20 and has no selection for viewers', async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 21 }, (_, i) => q(i + 1));
    const { unmount } = render(<Bank items={items} />);
    // fireEvent keeps 20 clicks fast; the cap logic is what is under test.
    for (let n = 1; n <= 20; n += 1) {
      fireEvent.click(screen.getByRole('checkbox', { name: `${n}번 문제 선택` }));
    }
    expect(screen.getByRole('checkbox', { name: '21번 문제 선택' })).toBeDisabled();
    expect(screen.getByRole('region', { name: '선택한 문제' })).toHaveTextContent(
      '20개 선택됨 · 최대 20개까지',
    );
    await user.click(screen.getByRole('button', { name: '선택 해제' }));
    expect(screen.queryByRole('region', { name: '선택한 문제' })).toBeNull();
    unmount();

    render(<Bank items={[q(1)]} readOnly="viewer" />);
    expect(screen.queryByRole('checkbox', { name: '1번 문제 선택' })).toBeNull();
  });
});

describe('GenerationBatchView', () => {
  it('shows the progress and one group per source with a review link that keeps the batch', () => {
    const b = batch([
      run(1),
      run(2, { status: 'failed', error_code: 'llm_unavailable', draft_count: 0 }),
    ]);
    render(
      <GenerationBatchView workspaceId={WS} batchId={BATCH} initialBatch={b} loadFailed={false} />,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('묶음 변형 출제');
    expect(screen.getByRole('progressbar', { name: '묶음 생성 진행률' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
    const groups = within(screen.getByRole('list', { name: '원본별 변형 결과' })).getAllByRole(
      'listitem',
    );
    expect(groups).toHaveLength(2);
    const [first, second] = groups as [HTMLElement, HTMLElement];
    expect(first).toHaveTextContent('원본 1');
    expect(first).toHaveTextContent('초안 1개');
    expect(within(first).getByRole('link', { name: '초안 검토' })).toHaveAttribute(
      'href',
      generatePath(WS, run(1).source_question_id, run(1).id, BATCH),
    );
    expect(second).toHaveTextContent('생성 모델에 연결하지 못했습니다');
  });

  it('says when the batch is not found here', () => {
    render(
      <GenerationBatchView
        workspaceId={WS}
        batchId={BATCH}
        initialBatch={null}
        loadFailed={false}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('묶음 변형 출제를 찾을 수 없습니다');
  });
});
