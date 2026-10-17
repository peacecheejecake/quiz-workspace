// @vitest-environment jsdom
// QGEN-01 screen (M6.3 review fix): draft updates are scoped to the run they were issued for.
// A response that arrives after the reviewer switched to another run in "생성 기록" must not land
// in that run's list (else a later publish sends one run's draft ids against another), and
// switching is locked while a publish and its refresh are in flight.
import './dom-setup';
import { ToastProvider } from '@quiz/ui';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportDraft } from '../src/lib/questions/drafts';
import type { QuestionDetail } from '../src/lib/questions/form';
import type { GenerationRun } from '../src/lib/questions/generation-client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../src/lib/questions/practice-actions', () => ({
  openPracticeSessionAction: vi.fn(),
  submitPracticeAction: vi.fn(),
  selfGradePracticeAction: vi.fn(),
  setMyStateAction: vi.fn(),
  lookupOverviewQuestionAction: vi.fn(),
}));
vi.mock('../src/lib/questions/actions', () => ({ getQuestionRevisionAction: vi.fn() }));

const { QuestionGeneration } =
  await import('../src/components/questions/generate/question-generation');

const WS = '55555555-5555-4555-8555-555555555555';
const SOURCE_ID = '33333333-3333-4333-8333-333333333333';
const REV_ID = '44444444-4444-4444-8444-444444444444';
const RUN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const SOURCE = {
  id: SOURCE_ID,
  workspace_id: WS,
  question_type: 'MCQ',
  publication_status: 'CONFIRMED',
  origin: 'manual',
  question_number: 1,
  chapter_id: null,
  chapter: null,
  sources: [],
  revisions: [],
  created_at: '2026-10-18T00:00:00Z',
  updated_at: '2026-10-18T00:00:00Z',
  revision: {
    id: REV_ID,
    version: 1,
    stem: '원본 문제',
    options: [
      { id: 'opt-1', text: '가' },
      { id: 'opt-2', text: '나' },
    ],
    correct_option_ids: ['opt-1'],
    is_multi_answer: false,
    accepted_answers: null,
    explanation: null,
    rubric: null,
    created_at: '2026-10-18T00:00:00Z',
  },
} as unknown as QuestionDetail;

function run(id: string, type: GenerationRun['variation_types'][number], created: string) {
  return {
    id,
    workspace_id: WS,
    status: 'succeeded',
    job_id: null,
    error_code: null,
    source_question_id: SOURCE_ID,
    source_question_revision_id: REV_ID,
    variation_types: [type],
    candidate_count: 1,
    difficulty: null,
    draft_count: 1,
    published_count: 0,
    llm_model: 'fake',
    prompt_version: 'v1',
    created_at: created,
    updated_at: created,
    finished_at: created,
  } as GenerationRun;
}

const A = run(RUN_A, 'PARAPHRASE', '2026-10-18T02:00:00Z');
const B = run(RUN_B, 'INVERT_POLARITY', '2026-10-17T02:00:00Z');

function draft(id: string, runId: string, stem: string, review = 'pending'): ImportDraft {
  return {
    id,
    import_id: null,
    run_id: runId,
    variation_type: 'PARAPHRASE',
    acknowledged_codes: [],
    position: 0,
    question_number: null,
    question_type: 'MCQ',
    is_multi_answer: false,
    rubric: null,
    review_status: review,
    published_question_id: null,
    validations: [],
    answer_missing: false,
    pages: [],
    publishable: true,
    publish_errors: [],
    version: `${id}-v1`,
    reviewed_at: null,
    created_at: '2026-10-18T00:00:00Z',
    updated_at: '2026-10-18T00:00:00Z',
    payload: {
      schema_version: 1,
      id: `gen-${id}`,
      origin: 'generation',
      question_type: 'MCQ',
      stem,
      options: [
        { id: 'opt-1', text: '가' },
        { id: 'opt-2', text: '나' },
      ],
      correct_option_ids: ['opt-1'],
      accepted_answers: null,
      explanation: null,
      review_status: review,
      validations: [],
      evidence: [],
    },
  } as unknown as ImportDraft;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function renderScreen(initialDrafts: ImportDraft[]) {
  return render(
    <ToastProvider>
      <QuestionGeneration
        workspaceId={WS}
        readOnly={null}
        source={SOURCE}
        initialRuns={[A, B]}
        initialRun={A}
        initialRunRevision={null}
        initialDrafts={initialDrafts}
        loadFailed={false}
      />
    </ToastProvider>,
  );
}

const draftList = () => screen.getByRole('list', { name: '생성된 초안' });
/** The stem shows in the draft and in its diff, so "shown" means at least once. */
const shows = (text: string) => within(draftList()).queryAllByText(text).length > 0;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QuestionGeneration run scoping', () => {
  it("never lets a late response of run A replace run B's drafts or reach B's publish", async () => {
    const lateApproval = deferred<Response>();
    const published: { url: string; ids: string[] }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/question-drafts/a1') && method === 'PATCH') return lateApproval.promise;
        if (url.endsWith('/question-drafts/b1') && method === 'PATCH') {
          return json(200, draft('b1', RUN_B, '변형 B', 'approved'));
        }
        if (url.endsWith(`/question-generations/${RUN_A}/drafts`)) {
          return json(200, { items: [draft('a1', RUN_A, '변형 A', 'approved')] });
        }
        if (url.endsWith(`/question-generations/${RUN_B}/drafts`)) {
          return json(200, { items: [draft('b1', RUN_B, '변형 B')] });
        }
        if (url.endsWith('/publish')) {
          const body = JSON.parse(String(init?.body)) as { drafts: { draft_id: string }[] };
          published.push({ url, ids: body.drafts.map((d) => d.draft_id) });
          return json(200, {
            items: body.drafts.map((d) => ({ draft_id: d.draft_id, question_id: 'q-new' })),
          });
        }
        if (url.endsWith(`/question-generations/${RUN_B}`)) return json(200, B);
        return json(404, {});
      }),
    );
    const user = userEvent.setup();
    renderScreen([draft('a1', RUN_A, '변형 A')]);

    // Approve A's draft; the response is slow. Meanwhile switch to run B.
    await user.click(within(draftList()).getByRole('checkbox', { name: /승인/ }));
    await user.click(screen.getByRole('combobox', { name: '생성 기록' }));
    await user.click(await screen.findByRole('option', { name: /정오 반전/ }));
    await waitFor(() => expect(shows('변형 B')).toBe(true));

    // A's approval is refused late (409 stale-draft), which re-reads A's drafts: B's list stays
    // untouched and nothing of A becomes publishable under B.
    await act(async () => {
      lateApproval.resolve(
        json(409, { type: 'urn:quiz-workspace:problem:stale-draft', status: 409 }),
      );
      await lateApproval.promise;
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(shows('변형 A')).toBe(false);
    expect(within(draftList()).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /승인한 문제 등록 \(0\)/ })).toBeDisabled();

    // Publishing B sends only B's drafts to B.
    await user.click(within(draftList()).getByRole('checkbox', { name: /승인/ }));
    await user.click(await screen.findByRole('button', { name: /승인한 문제 등록 \(1\)/ }));
    await waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]).toEqual({
      url: `/api/question-generations/${RUN_B}/publish`,
      ids: ['b1'],
    });
  });

  it('locks run switching while a publish and its refresh are in flight', async () => {
    const publishResponse = deferred<Response>();
    const refreshResponse = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/question-generations/${RUN_A}/publish`)) return publishResponse.promise;
        if (url.endsWith(`/question-generations/${RUN_A}/drafts`)) return refreshResponse.promise;
        if (url.endsWith(`/question-generations/${RUN_A}`)) return json(200, A);
        return json(404, {});
      }),
    );
    const user = userEvent.setup();
    renderScreen([draft('a1', RUN_A, '변형 A', 'approved')]);
    const history = screen.getByRole('combobox', { name: '생성 기록' });
    expect(history).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /승인한 문제 등록 \(1\)/ }));
    expect(history).toBeDisabled();

    await act(async () => {
      publishResponse.resolve(json(200, { items: [{ draft_id: 'a1', question_id: 'q-1' }] }));
      await publishResponse.promise;
    });
    // Registered, but the refresh of A's drafts is still running: still locked.
    expect(within(draftList()).getByText('등록됨')).toBeInTheDocument();
    expect(history).toBeDisabled();

    await act(async () => {
      refreshResponse.resolve(json(200, { items: [draft('a1', RUN_A, '변형 A', 'approved')] }));
      await refreshResponse.promise;
    });
    await waitFor(() => expect(history).toBeEnabled());
  });
});
