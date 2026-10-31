// QIMPORT-01 first render (QIMP-PAYLOAD): the server hands the drafts to the client screen in the
// review shape, not as the API's `ImportDraft`s, so a ~1000-draft paper does not ship the
// validations, timestamps, run ids and extraction block ids the screen never reads in the
// initial RSC payload. The loader runs against a mocked API client and Next runtime.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reviewDraftFromImport,
  type BookChapterOption,
  type ImportDraft,
  type ImportRun,
} from '../src/lib/questions/drafts';

const api = { GET: vi.fn() };

vi.mock('../src/lib/api/server', () => ({
  NotAuthenticatedError: class NotAuthenticatedError extends Error {},
  createServerApiClient: async () => api,
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));

const { loadLatestImport } = await import('../src/lib/questions/import-data');

const WS = '55555555-5555-4555-8555-555555555555';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const REV = '66666666-6666-4666-8666-666666666666';
const BOOK = '77777777-7777-4777-8777-777777777777';
/** The size of a real paper (316 pages, QIMP-REVIEW-SCALE). */
const COUNT = 752;

const RUN: ImportRun = {
  id: RUN_ID,
  workspace_id: WS,
  status: 'succeeded',
  job_id: null,
  error_code: null,
  source_document_id: DOC,
  source_document_revision_id: REV,
  document_title: '문제지',
  draft_count: COUNT,
  published_count: 0,
  registration_job_id: null,
  created_at: '2026-10-18T00:00:00Z',
  updated_at: '2026-10-18T00:00:00Z',
  finished_at: '2026-10-18T00:00:00Z',
};

const chapterId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const CHAPTERS: BookChapterOption[] = Array.from({ length: 300 }, (_, i) => ({
  id: chapterId(i),
  title: `제${i + 1}장 단원`,
  document_id: BOOK,
  document_title: '교재',
  level: 1,
}));

const uuid = (i: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`;

/** An MCQ import draft as the API returns it, sized like an extracted exam question. */
function apiDraft(i: number): ImportDraft {
  const missing = i % 5 === 0;
  return {
    id: uuid(i),
    import_id: RUN_ID,
    run_id: null,
    variation_type: null,
    acknowledged_codes: [],
    position: i,
    question_number: i + 1,
    question_type: 'MCQ',
    is_multi_answer: false,
    rubric: null,
    review_status: 'pending',
    published_question_id: null,
    validations: missing
      ? [{ code: 'answer_missing', severity: 'warning', message: 'No answer in the source.' }]
      : [],
    answer_missing: missing,
    pages: [Math.floor(i / 3) + 1],
    publishable: !missing,
    publish_errors: missing ? [{ field: 'correct_option_ids', message: 'No answer.' }] : [],
    version: `v${i.toString(16).padStart(12, '0')}`,
    reviewed_at: null,
    created_at: '2026-10-18T00:00:00.000000Z',
    updated_at: '2026-10-18T00:00:00.000000Z',
    chapter: {
      id: chapterId(i % 300),
      title: `제${(i % 300) + 1}장 단원`,
      document_id: BOOK,
      document_title: '교재',
    },
    chapter_choice: 'auto',
    chapter_match: 'matched',
    source_chapter_title: `제${(i % 300) + 1}장 단원`,
    payload: {
      schema_version: 1,
      id: `${DOC}-q${String(i + 1).padStart(3, '0')}`,
      origin: 'pdf_import',
      question_type: 'MCQ',
      stem: `다음 중 금융 상품 ${i}에 관한 설명으로 옳지 않은 것은 무엇인가? 보기를 읽고 고르시오.`,
      options: Array.from({ length: 4 }, (_, o) => ({
        id: `opt-${o + 1}`,
        text: `보기 ${o + 1}: 예금자 보호 한도와 이자 지급 방식에 관한 설명`,
      })),
      correct_option_ids: missing ? null : ['opt-2'],
      accepted_answers: null,
      explanation: missing ? null : '해설: 예금자 보호 한도는 1인당 원금과 이자를 합해 정해진다.',
      justification: null,
      evidence: [
        {
          document_id: DOC,
          revision_id: REV,
          block_ids: [`cb-p${i}-b001-0123456789`, `cb-p${i}-b002-0123456789`],
          locations: [
            {
              page: Math.floor(i / 3) + 1,
              bbox: { x0: 64, y0: 138, x1: 337.67, y1: 229.5 },
              block_id: null,
            },
          ],
          quote: null,
        },
      ],
      variation_type: null,
      parent_question_id: null,
      source_question_revision_id: null,
      generator: null,
      validations: missing
        ? [{ code: 'answer_missing', severity: 'warning', message: 'No answer in the source.' }]
        : [],
      review_status: 'pending',
    },
  };
}

const ok = (data: unknown) => ({ data, error: undefined, response: new Response(null) });

describe('loadLatestImport (QIMP-PAYLOAD)', () => {
  const items = Array.from({ length: COUNT }, (_, i) => apiDraft(i));

  beforeEach(() => {
    api.GET.mockReset();
    api.GET.mockImplementation(async (path: string) =>
      path.endsWith('/question-imports')
        ? ok({ items: [RUN] })
        : // Out of order: the screen still lists the drafts in source order.
          ok({ items: [...items].reverse(), chapters: CHAPTERS }),
    );
  });

  it('hands the drafts over in the review shape, in source order', async () => {
    const data = await loadLatestImport(WS);
    expect(data.loadFailed).toBe(false);
    expect(data.run).toEqual(RUN);
    expect(data.chapters).toEqual(CHAPTERS);
    expect(data.drafts).toEqual(items.map(reviewDraftFromImport));
  });

  it('leaves out the API fields the screen never reads', async () => {
    const { drafts } = await loadLatestImport(WS);
    const sent = JSON.stringify(drafts);
    for (const field of [
      'import_id',
      'created_at',
      'updated_at',
      'reviewed_at',
      'publish_errors',
      'schema_version',
      'block_ids',
      'revision_id',
      'payload',
      'message',
    ]) {
      expect(sent, field).not.toContain(`"${field}"`);
    }
  });

  it('keeps the initial payload well under the API response for a paper-sized import', async () => {
    const { drafts } = await loadLatestImport(WS);
    const sent = new TextEncoder().encode(JSON.stringify(drafts)).length;
    const api = new TextEncoder().encode(JSON.stringify(items)).length;
    // ~2.1 kB → ~1.4 kB per draft here (two thirds is Korean question text, 3 bytes a
    // character); a field added to the review shape by mistake shows up here.
    expect(sent / api).toBeLessThan(0.7);
  });
});
