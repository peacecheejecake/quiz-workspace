// @vitest-environment jsdom
// UX6-SELECT (QIMPORT-01-AC09): with hundreds of drafts, checking a draft or "전체 선택" is an
// instant, screen-only change. Nothing is requested, and the drafts' contents (here: the chapter
// picker each draft renders, a Radix Select over every book chapter) are not rendered again — only
// the checkboxes whose state changed. "선택한 문제 승인 및 등록" then sends the whole selection.
import './dom-setup';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportDraft, ImportRun } from '../src/lib/questions/drafts';

// Next's router is one object for the page's life, as here.
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../src/components/questions/import/source-compare-panel', () => ({
  SourceComparePanel: () => null,
}));
const chapterRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/components/questions/import/draft-chapter-field', () => ({
  DraftChapterField: ({ number }: { number: number }) => {
    chapterRenders.count += 1;
    return <p>{number}번 문제 챕터</p>;
  },
}));

const { QuestionImport } = await import('../src/components/questions/import/question-import');

const WS = '55555555-5555-4555-8555-555555555555';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const COUNT = 120;

const RUN: ImportRun = {
  id: RUN_ID,
  workspace_id: WS,
  status: 'succeeded',
  job_id: null,
  error_code: null,
  source_document_id: DOC,
  source_document_revision_id: null,
  document_title: '문제지',
  draft_count: COUNT,
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
    chapter: null,
    chapter_choice: 'auto',
    chapter_match: 'no_match',
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QuestionImport selection with many drafts (UX6-SELECT)', () => {
  it('QIMPORT-01-AC09 checking a draft or 전체 선택 re-renders only the checkboxes and requests nothing', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/registrations')) {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response('{}', { status: 503 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QuestionImport
        workspaceId={WS}
        readOnly={null}
        initialRun={RUN}
        initialDrafts={Array.from({ length: COUNT }, (_, i) => draft(i))}
        loadFailed={false}
      />,
    );
    expect(chapterRenders.count).toBe(COUNT);
    const user = userEvent.setup();
    const all = screen.getByRole('checkbox', { name: `전체 선택 (${COUNT}개)` });
    const publishButton = () => screen.getByRole('button', { name: /선택한 문제 승인 및 등록/ });
    const one = (n: number) => screen.getByRole('checkbox', { name: `${n}번 문제 선택` });
    chapterRenders.count = 0;

    await user.click(all);
    expect(all.getAttribute('aria-checked')).toBe('true');
    expect(one(COUNT).getAttribute('aria-checked')).toBe('true');
    expect(publishButton().textContent).toContain(`(${COUNT})`);
    await user.click(one(7));
    expect(one(7).getAttribute('aria-checked')).toBe('false');
    expect(all.getAttribute('aria-checked')).toBe('mixed');
    expect(publishButton().textContent).toContain(`(${COUNT - 1})`);
    await user.click(one(7));
    await user.click(all);
    expect(one(1).getAttribute('aria-checked')).toBe('false');
    expect(publishButton().textContent).toContain('(0)');
    await user.click(one(3));
    expect(publishButton().textContent).toContain('(1)');

    // No draft's content was rendered again, and nothing reached the server.
    expect(chapterRenders.count).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(all);
    await user.click(publishButton());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodies).toEqual([
      {
        drafts: Array.from({ length: COUNT }, (_, i) => ({
          draft_id: `d-${i}`,
          version: `v-${i}`,
          chapter_id: null,
        })),
      },
    ]);
  });
});
