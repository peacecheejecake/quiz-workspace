// @vitest-environment jsdom
// QIMP-PAGING (QIMPORT-01-AC09): the import screen gets a summary of every draft and the content
// of the first page; another page's content is read when the page is shown (a loading state
// until then, the neighbouring pages read ahead), while 전체 선택, the counts and the
// registration cover every draft from the summaries. A failed page read offers a retry.
import './dom-setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reviewDraftFromImport,
  type ImportDraft,
  type ImportRun,
} from '../src/lib/questions/drafts';
import { DRAFT_PAGE_SIZE, summaryFromImport } from '../src/lib/questions/draft-pages';

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
const CHAPTER = '77777777-7777-4777-8777-777777777777';
const TOTAL = 250;

const RUN: ImportRun = {
  id: RUN_ID,
  workspace_id: WS,
  status: 'succeeded',
  job_id: null,
  error_code: null,
  source_document_id: DOC,
  source_document_revision_id: null,
  document_title: '문제지',
  draft_count: TOTAL,
  published_count: 0,
  registration_job_id: null,
  created_at: '2026-10-18T00:00:00Z',
  updated_at: '2026-10-18T00:00:00Z',
  finished_at: '2026-10-18T00:00:00Z',
};

function draft(i: number): ImportDraft {
  return {
    id: `d-${i}`,
    import_id: RUN_ID,
    position: i,
    question_number: i + 1,
    question_type: 'SHORT_ANSWER',
    is_multi_answer: false,
    rubric: null,
    review_status: 'pending',
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
    chapter:
      i % 2 === 0
        ? { id: CHAPTER, title: '제1장', document_id: DOC, document_title: '교재' }
        : null,
    chapter_choice: 'auto',
    chapter_match: i % 2 === 0 ? 'matched' : 'no_match',
    source_chapter_title: null,
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
      review_status: 'pending',
    },
  };
}

const ALL = Array.from({ length: TOTAL }, (_, i) => draft(i));
const SUMMARIES = ALL.map((d) =>
  summaryFromImport({
    id: d.id,
    version: d.version,
    position: d.position,
    question_number: d.question_number,
    question_type: d.question_type,
    review_status: d.review_status,
    published_question_id: d.published_question_id,
    publishable: d.publishable,
    answer_missing: d.answer_missing,
    validations: [],
    chapter_id: d.chapter?.id ?? null,
  }),
);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Page reads (`offset`s) the screen made; `hold` keeps a page's response until released. */
function pageServer(options: { fail?: Set<number> } = {}) {
  const offsets: number[] = [];
  const held = new Map<number, () => void>();
  const bodies: { drafts: { draft_id: string; chapter_id?: string | null }[] }[] = [];
  const hold = new Set<number>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://web.test');
    if (url.pathname.endsWith('/registrations')) {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      return json(503, {});
    }
    if (url.pathname.endsWith('/draft-summaries')) {
      return json(200, {
        items: ALL.map((d) => ({
          id: d.id,
          version: d.version,
          position: d.position,
          question_number: d.question_number,
          question_type: d.question_type,
          review_status: d.review_status,
          published_question_id: d.published_question_id,
          publishable: d.publishable,
          answer_missing: d.answer_missing,
          validations: [],
          chapter_id: d.chapter?.id ?? null,
        })),
        chapters: [],
      });
    }
    if (url.pathname.endsWith('/drafts')) {
      const offset = Number(url.searchParams.get('offset'));
      expect(url.searchParams.get('limit')).toBe(String(DRAFT_PAGE_SIZE));
      expect(url.searchParams.get('include_chapters')).toBe('false');
      offsets.push(offset);
      if (hold.has(offset)) await new Promise<void>((resolve) => held.set(offset, resolve));
      if (options.fail?.has(offset)) {
        options.fail.delete(offset);
        return json(503, {});
      }
      return json(200, {
        items: ALL.slice(offset, offset + DRAFT_PAGE_SIZE),
        total: TOTAL,
      });
    }
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return { offsets, hold, held, bodies, fetchMock };
}

function renderScreen() {
  render(
    <QuestionImport
      workspaceId={WS}
      readOnly={null}
      initialRun={RUN}
      initialDrafts={ALL.slice(0, DRAFT_PAGE_SIZE).map(reviewDraftFromImport)}
      initialSummaries={SUMMARIES}
      loadFailed={false}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QuestionImport page-by-page content (QIMP-PAGING)', { timeout: 30_000 }, () => {
  it('QIMPORT-01-AC09 reads a page when shown, reads ahead, and selects and registers over all drafts', async () => {
    const server = pageServer();
    server.hold.add(DRAFT_PAGE_SIZE * 2);
    renderScreen();
    const user = userEvent.setup();
    const top = screen.getAllByRole('navigation', { name: /초안 페이지/ })[0] as HTMLElement;
    const section = screen.getByRole('region', { name: /가져온 초안/ });

    // The first page came with the page; its neighbour is read ahead.
    expect(screen.getByRole('checkbox', { name: '1번 문제 선택' })).toBeTruthy();
    await waitFor(() => expect(server.offsets).toEqual([DRAFT_PAGE_SIZE]));
    expect(screen.getByRole('checkbox', { name: `전체 선택 (${TOTAL}개)` })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /가져온 초안/ }).textContent).toContain(
      `${TOTAL}개`,
    );

    // Page 2 was read ahead: shown at once. Page 3 is read ahead now and held.
    await user.click(within(top).getByRole('button', { name: '2페이지' }));
    expect(screen.getByRole('checkbox', { name: '101번 문제 선택' })).toBeTruthy();
    await waitFor(() => expect(server.offsets).toEqual([DRAFT_PAGE_SIZE, DRAFT_PAGE_SIZE * 2]));

    // Page 3 is not there yet: a loading state, then its drafts.
    await user.click(within(top).getByRole('button', { name: '3페이지' }));
    expect(screen.getByText(`초안 201–${TOTAL}을 불러오는 중입니다…`)).toBeTruthy();
    expect(section.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('list', { name: '가져온 초안' })).toBeNull();
    server.held.get(DRAFT_PAGE_SIZE * 2)?.();
    expect(await screen.findByRole('checkbox', { name: '201번 문제 선택' })).toBeTruthy();
    expect(section.getAttribute('aria-busy')).toBeNull();
    // Each page is read once.
    expect(server.offsets).toEqual([DRAFT_PAGE_SIZE, DRAFT_PAGE_SIZE * 2]);

    // 전체 선택 covers every draft; the registration sends them with their chapters.
    await user.click(screen.getByRole('checkbox', { name: `전체 선택 (${TOTAL}개)` }));
    await user.click(screen.getByRole('button', { name: /선택한 문제 승인 및 등록/ }));
    await waitFor(() => expect(server.bodies).toHaveLength(1));
    const sent = server.bodies[0]?.drafts ?? [];
    expect(sent).toHaveLength(TOTAL);
    expect(sent[0]).toEqual({ draft_id: 'd-0', version: 'v-0', chapter_id: CHAPTER });
    expect(sent[1]).toEqual({ draft_id: 'd-1', version: 'v-1', chapter_id: null });
  });

  it('QIMPORT-01-AC09 a page that cannot be read offers 다시 시도, which reads the list again', async () => {
    const server = pageServer({ fail: new Set([DRAFT_PAGE_SIZE]) });
    renderScreen();
    const user = userEvent.setup();
    await waitFor(() => expect(server.offsets).toEqual([DRAFT_PAGE_SIZE]));
    const top = screen.getAllByRole('navigation', { name: /초안 페이지/ })[0] as HTMLElement;
    await user.click(within(top).getByRole('button', { name: '2페이지' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('초안 101–200을 불러오지 못했습니다.');
    await user.click(within(alert).getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByRole('checkbox', { name: '101번 문제 선택' })).toBeTruthy();
    const summaryReads = server.fetchMock.mock.calls.filter(([u]) =>
      String(u).endsWith('/draft-summaries'),
    );
    expect(summaryReads).toHaveLength(1);
  });
});
