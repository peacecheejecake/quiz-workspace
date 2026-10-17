// @vitest-environment jsdom
// QIMPORT-01 screen behaviour the E2E specs cannot reach: recovering from a failed first load with
// "목록 새로고침" (no full page reload), and publishing more approved drafts than the API accepts per
// request (MAX_PUBLISH = 200) in batches, retrying only what is left after a failed batch.
import './dom-setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportDraft, ImportRun } from '../src/lib/questions/drafts';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../src/components/questions/import/source-compare-panel', () => ({
  SourceComparePanel: () => null,
}));

const { QuestionImport } = await import('../src/components/questions/import/question-import');

const WS = '55555555-5555-4555-8555-555555555555';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';

const RUN: ImportRun = {
  id: RUN_ID,
  workspace_id: WS,
  status: 'succeeded',
  job_id: null,
  error_code: null,
  source_document_id: DOC,
  source_document_revision_id: null,
  document_title: '문제지',
  draft_count: 1,
  published_count: 0,
  created_at: '2026-10-18T00:00:00Z',
  updated_at: '2026-10-18T00:00:00Z',
  finished_at: '2026-10-18T00:00:00Z',
};

function draft(i: number, review: ImportDraft['review_status'] = 'pending'): ImportDraft {
  return {
    id: `d-${i}`,
    import_id: RUN_ID,
    position: i,
    question_number: i + 1,
    question_type: 'SHORT_ANSWER',
    is_multi_answer: false,
    rubric: null,
    review_status: review,
    published_question_id: null,
    validations: [],
    answer_missing: false,
    pages: [1],
    publishable: true,
    publish_errors: [],
    version: `v-${i}`,
    reviewed_at: null,
    created_at: '2026-10-18T00:00:00Z',
    updated_at: '2026-10-18T00:00:00Z',
    payload: {
      schema_version: 1,
      id: `${DOC}-q${i}`,
      origin: 'pdf_import',
      question_type: 'SHORT_ANSWER',
      stem: `문제 본문 ${i}`,
      options: [],
      correct_option_ids: null,
      accepted_answers: ['답'],
      evidence: [{ document_id: DOC, locations: [{ page: 1 }] }],
      validations: [],
      review_status: review,
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QuestionImport', () => {
  it('recovers from a failed first load with "목록 새로고침" without a page reload', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/question-imports?limit=1')) return json(200, { items: [RUN] });
      if (url.endsWith(`/question-imports/${RUN_ID}/drafts`)) {
        return json(200, { items: [draft(0)] });
      }
      return json(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QuestionImport
        workspaceId={WS}
        readOnly={null}
        initialRun={null}
        initialDrafts={[]}
        loadFailed
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('불러오지 못했습니다');

    await userEvent.setup().click(screen.getByRole('button', { name: '목록 새로고침' }));

    const list = await screen.findByRole('list', { name: '가져온 초안' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('문제 본문 0')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('publishes more than 200 approved drafts in batches and retries only the rest', async () => {
    const drafts = Array.from({ length: 450 }, (_, i) => draft(i, 'approved'));
    const sent: number[] = [];
    let publishCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/publish')) {
        publishCalls += 1;
        const body = JSON.parse(String(init?.body)) as { drafts: { draft_id: string }[] };
        sent.push(body.drafts.length);
        if (publishCalls === 2) throw new TypeError('Failed to fetch');
        return json(200, {
          items: body.drafts.map((d) => ({ draft_id: d.draft_id, question_id: `q-${d.draft_id}` })),
        });
      }
      if (url.endsWith('/drafts')) {
        // Keep the screen's own view (the server state is not modelled here).
        return json(503, {});
      }
      return json(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QuestionImport
        workspaceId={WS}
        readOnly={null}
        initialRun={{ ...RUN, draft_count: 450 }}
        initialDrafts={drafts}
        loadFailed={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /승인한 문제 등록 \(450\)/ }));

    const failure = await screen.findByText(/지금까지 200개를 등록했습니다/);
    expect(failure).toBeTruthy();
    expect(sent).toEqual([200, 200]);

    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        '450개 문제를 문제은행에 등록했습니다.',
      ),
    );
    // The retry resends the lost batch (idempotent) and the remainder, never the first batch.
    expect(sent).toEqual([200, 200, 200, 50]);
  }, 30_000);
});
