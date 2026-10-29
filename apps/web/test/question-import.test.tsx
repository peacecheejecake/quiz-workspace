// @vitest-environment jsdom
// QIMPORT-01 screen behaviour the E2E specs cannot reach: recovering from a failed first load with
// "목록 새로고침" (no full page reload), the server-side registration (QIMP-JOB: one request with the
// whole selection, progress while the job runs, a retry after a lost response reuses its
// Idempotency-Key, reattaching to a running registration on load) and the selection (QIMP-BULK):
// checks send nothing, "전체 선택" scope and states, refused drafts stay selected.
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
const JOB = '44444444-4444-4444-8444-444444444444';

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
  registration_job_id: null,
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

function registration(
  status: 'queued' | 'running' | 'succeeded' | 'failed',
  total: number,
  processed: number,
) {
  return {
    job_id: JOB,
    import_id: RUN_ID,
    status,
    error_code: null,
    total,
    processed,
    registered: processed,
    skipped: 0,
    refused: [],
    created_at: '2026-10-18T00:00:00Z',
    finished_at: status === 'succeeded' ? '2026-10-18T00:01:00Z' : null,
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

  it('QIMP-JOB: submits the whole selection once, follows the job and retries with the same key', async () => {
    const drafts = Array.from({ length: 450 }, (_, i) => draft(i, 'approved'));
    const bodies: { drafts: { draft_id: string }[] }[] = [];
    const keys: (string | undefined)[] = [];
    let polls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/registrations')) {
        bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
        keys.push((init?.headers as Record<string, string>)['idempotency-key']);
        if (bodies.length === 1) throw new TypeError('Failed to fetch');
        return json(202, registration('queued', 0, 0));
      }
      if (url.endsWith(`/registrations/${JOB}`)) {
        polls += 1;
        return json(
          200,
          polls < 2 ? registration('running', 200, 200) : registration('succeeded', 450, 450),
        );
      }
      if (url.endsWith('/drafts')) {
        return json(200, {
          items: drafts.map((d) => ({ ...d, published_question_id: `q-${d.id}` })),
        });
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
        registrationPollMs={5}
      />,
    );
    const user = userEvent.setup();
    // Drafts approved before QIMP-BULK start selected.
    await user.click(screen.getByRole('button', { name: /선택한 문제 승인 및 등록 \(450\)/ }));
    expect(await screen.findByText(/선택한 문제를 등록하지 못했습니다/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        '450개 문제를 문제은행에 등록했습니다.',
      ),
    );
    // One request with every selected draft; the retry of the lost one reuses its key.
    expect(bodies.map((b) => b.drafts.length)).toEqual([450, 450]);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(polls).toBe(2);
    expect(screen.queryByRole('progressbar', { name: '등록 진행률' })).toBeNull();
  }, 30_000);

  it('QIMP-JOB: reattaches to a registration that is still running when the page opens', async () => {
    const drafts = [draft(0, 'approved'), draft(1, 'approved')];
    let polls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/registrations/${JOB}`)) {
        polls += 1;
        if (polls === 1) return json(200, registration('running', 2, 1));
        if (polls === 2) return json(200, registration('running', 2, 1));
        return json(200, {
          ...registration('succeeded', 2, 2),
          registered: 1,
          refused: [{ draft_id: 'd-1', reason: 'stale-draft', question_number: 2, position: 1 }],
        });
      }
      if (url.endsWith('/drafts')) {
        return json(200, {
          items: [
            { ...drafts[0], published_question_id: 'q-0' },
            { ...draft(1), version: 'v-1b' },
          ],
        });
      }
      return json(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QuestionImport
        workspaceId={WS}
        readOnly={null}
        initialRun={{ ...RUN, draft_count: 2, registration_job_id: JOB }}
        initialDrafts={drafts}
        loadFailed={false}
        registrationPollMs={20}
      />,
    );
    const bar = await screen.findByRole('progressbar', { name: '등록 진행률' });
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText(/승인·등록 중 · 2개 중 1개 처리/)).toBeTruthy();
    expect(
      screen.getByText(/이 페이지를 떠나도 선택한 문제의 승인·등록은 서버에서 계속됩니다/),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /선택한 문제 승인 및 등록/ }).hasAttribute('disabled'),
    ).toBe(true);

    expect(await screen.findByText(/2번\(다른 곳에서 바뀜\)/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('1개 문제를 문제은행에 등록했습니다.');
    expect(screen.queryByRole('progressbar', { name: '등록 진행률' })).toBeNull();
    const draft2 = screen.getByRole('listitem', { name: '2번 문제' });
    expect(within(draft2).getByRole('alert').textContent).toContain('다른 곳에서 바뀌어');
  });

  it('checks send nothing; "전체 선택" covers what can be registered; refused drafts stay selected', async () => {
    const blocked: ImportDraft = {
      ...draft(2),
      publishable: false,
      answer_missing: true,
      payload: { ...draft(2).payload, accepted_answers: null },
    };
    const published: ImportDraft = {
      ...draft(3, 'approved'),
      published_question_id: 'q-done',
    };
    const initial = [draft(0), draft(1), blocked, published];
    const bodies: {
      drafts: { draft_id: string; version: string; chapter_id?: string | null }[];
    }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/registrations')) {
        const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
        bodies.push(body);
        return json(202, {
          ...registration('succeeded', 2, 2),
          registered: 1,
          refused: [{ draft_id: 'd-1', reason: 'stale-draft', question_number: 2, position: 1 }],
        });
      }
      if (url.endsWith('/drafts')) {
        return json(200, {
          items: [
            { ...draft(0, 'approved'), published_question_id: 'q-0' },
            { ...draft(1), version: 'v-1b' },
            blocked,
            published,
          ],
        });
      }
      return json(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QuestionImport
        workspaceId={WS}
        readOnly={null}
        initialRun={{ ...RUN, draft_count: 4, published_count: 1 }}
        initialDrafts={initial}
        loadFailed={false}
        registrationPollMs={5}
      />,
    );
    const user = userEvent.setup();
    const all = screen.getByRole('checkbox', { name: /전체 선택 \(2개\)/ });
    const publishButton = () => screen.getByRole('button', { name: /선택한 문제 승인 및 등록/ });
    expect(all.getAttribute('aria-checked')).toBe('false');
    expect(publishButton().textContent).toContain('(0)');
    expect(publishButton().hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('checkbox', { name: '3번 문제 선택' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.queryByRole('checkbox', { name: '4번 문제 선택' })).toBeNull();

    await user.click(all);
    expect(all.getAttribute('aria-checked')).toBe('true');
    expect(publishButton().textContent).toContain('(2)');
    await user.click(screen.getByRole('checkbox', { name: '2번 문제 선택' }));
    expect(all.getAttribute('aria-checked')).toBe('mixed');
    // From the mixed state a click selects the whole scope again; the next one clears it.
    await user.click(all);
    expect(all.getAttribute('aria-checked')).toBe('true');
    await user.click(all);
    expect(all.getAttribute('aria-checked')).toBe('false');
    expect(publishButton().textContent).toContain('(0)');
    await user.click(all);
    // Checking drafts never reaches the server.
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(publishButton());
    expect(bodies).toEqual([
      {
        drafts: [
          { draft_id: 'd-0', version: 'v-0', chapter_id: null },
          { draft_id: 'd-1', version: 'v-1', chapter_id: null },
        ],
      },
    ]);
    expect(await screen.findByText(/2번\(다른 곳에서 바뀜\)/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('1개 문제를 문제은행에 등록했습니다.');
    const draft2 = screen.getByRole('listitem', { name: '2번 문제' });
    expect(within(draft2).getByRole('alert').textContent).toContain('다른 곳에서 바뀌어');
    // The refused draft stays selected (at its reloaded version); the registered one drops out.
    await waitFor(() =>
      expect(screen.queryByRole('checkbox', { name: '1번 문제 선택' })).toBeNull(),
    );
    expect(
      screen.getByRole('checkbox', { name: '2번 문제 선택' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(publishButton().textContent).toContain('(1)');
    expect(screen.getByRole('checkbox', { name: /전체 선택 \(1개\)/ })).toBeTruthy();

    await user.click(publishButton());
    expect(bodies[1]).toEqual({ drafts: [{ draft_id: 'd-1', version: 'v-1b', chapter_id: null }] });
  });

  it('CHAPTER-MAP: shows the suggested chapter with why, and saves another choice at once', async () => {
    const CH1 = '66666666-6666-4666-8666-666666666661';
    const CH2 = '66666666-6666-4666-8666-666666666662';
    const BOOK = '77777777-7777-4777-8777-777777777777';
    const chapters = [
      { id: CH1, title: '1장 수신제도', level: 1, document_id: BOOK, document_title: '교재' },
      { id: CH2, title: '2장 여신제도', level: 1, document_id: BOOK, document_title: '교재' },
    ];
    const suggested: ImportDraft = {
      ...draft(0),
      chapter: { id: CH1, title: '1장 수신제도', document_id: BOOK, document_title: '교재' },
      chapter_choice: 'auto',
      chapter_match: 'matched',
      source_chapter_title: '제1장 수신제도',
    };
    const patches: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/question-drafts/') && init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)));
        return json(200, {
          ...suggested,
          version: 'v-0b',
          chapter: { id: CH2, title: '2장 여신제도', document_id: BOOK, document_title: '교재' },
          chapter_choice: 'manual',
          chapter_match: null,
          source_chapter_title: null,
        });
      }
      return json(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QuestionImport
        workspaceId={WS}
        readOnly={null}
        initialRun={RUN}
        initialDrafts={[suggested]}
        initialChapters={chapters}
        loadFailed={false}
      />,
    );
    const user = userEvent.setup();
    const picker = screen.getByRole('combobox', { name: '1번 문제 챕터' });
    expect(picker.textContent).toContain('1장 수신제도');
    expect(screen.getByText(/문제 PDF의 ‘제1장 수신제도’에 맞춰 자동으로 골랐습니다/)).toBeTruthy();

    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: '2장 여신제도' }));

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '1번 문제 챕터' }).textContent).toContain(
        '2장 여신제도',
      ),
    );
    expect(patches).toEqual([{ base_version: 'v-0', chapter_id: CH2 }]);
    expect(screen.getByText('직접 고른 챕터로 등록합니다.')).toBeTruthy();
  });

  it('CHAPTER-MAP: viewers see the chapter as text', () => {
    render(
      <QuestionImport
        workspaceId={WS}
        readOnly="viewer"
        initialRun={RUN}
        initialDrafts={[{ ...draft(0), chapter_match: 'no_match', source_chapter_title: '제9장' }]}
        loadFailed={false}
      />,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText(/챕터 없음/)).toBeTruthy();
  });

  it('Codex P2: a registration that ended after the server render is reported on arrival', async () => {
    const drafts = [draft(0, 'approved'), draft(1, 'approved')];
    let draftLoads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/registrations/${JOB}`)) {
        return json(200, {
          ...registration('succeeded', 2, 2),
          registered: 1,
          finished_at: '2026-10-18T00:01:02Z',
          refused: [{ draft_id: 'd-1', reason: 'stale-draft', question_number: 2, position: 1 }],
        });
      }
      if (url.endsWith('/drafts')) {
        draftLoads += 1;
        return json(200, {
          items: [
            { ...drafts[0], published_question_id: 'q-0' },
            { ...draft(1), version: 'v-1b' },
          ],
        });
      }
      return json(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QuestionImport
        workspaceId={WS}
        readOnly={null}
        initialRun={{ ...RUN, draft_count: 2, registration_job_id: JOB }}
        initialDrafts={drafts}
        loadFailed={false}
        loadedAt="2026-10-18T00:01:00Z"
        registrationPollMs={5}
      />,
    );
    expect(await screen.findByText(/2번\(다른 곳에서 바뀜\)/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('1개 문제를 문제은행에 등록했습니다.');
    expect(draftLoads).toBe(1);
    await waitFor(() =>
      expect(screen.queryByRole('checkbox', { name: '1번 문제 선택' })).toBeNull(),
    );
  });

  it('a registration that ended before the server render is not reported again', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/registrations/${JOB}`)) {
        return json(200, { ...registration('failed', 2, 0), finished_at: '2026-10-18T00:00:30Z' });
      }
      return json(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QuestionImport
        workspaceId={WS}
        readOnly={null}
        initialRun={{ ...RUN, registration_job_id: JOB }}
        initialDrafts={[draft(0)]}
        loadFailed={false}
        loadedAt="2026-10-18T00:01:00Z"
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/drafts'))).toBe(false);
  });
});
