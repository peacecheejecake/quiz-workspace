// @vitest-environment jsdom
// UX6-SELECT (QIMPORT-01-AC09): with hundreds of drafts, checking a draft or "전체 선택" is an
// instant, screen-only change. Nothing is requested, and the drafts' contents (here: the chapter
// picker each draft renders, a Radix Select over every book chapter) are not rendered again — only
// the checkboxes whose state changed. "선택한 문제 승인 및 등록" then sends the whole selection.
// QIMP-REVIEW-SCALE: the list renders one page of drafts; selection and counts cover them all.
import './dom-setup';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportDraft, ImportRun } from '../src/lib/questions/drafts';
import { DRAFT_PAGE_SIZE } from '../src/lib/questions/draft-pages';

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
    // Only the first page of drafts is rendered.
    expect(chapterRenders.count).toBe(DRAFT_PAGE_SIZE);
    const user = userEvent.setup();
    const all = screen.getByRole('checkbox', { name: `전체 선택 (${COUNT}개)` });
    const publishButton = () => screen.getByRole('button', { name: /선택한 문제 승인 및 등록/ });
    const one = (n: number) => screen.getByRole('checkbox', { name: `${n}번 문제 선택` });
    chapterRenders.count = 0;

    await user.click(all);
    expect(all.getAttribute('aria-checked')).toBe('true');
    expect(one(DRAFT_PAGE_SIZE).getAttribute('aria-checked')).toBe('true');
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

  it('QIMPORT-01-AC09 1000 drafts: one page is rendered, 전체 선택 and the counts cover all, paging keeps focus', async () => {
    const TOTAL = 1000;
    const bodies: { drafts: unknown[] }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/registrations')) {
        bodies.push(JSON.parse(String(init?.body)) as { drafts: unknown[] });
        return new Response('{}', { status: 503 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    chapterRenders.count = 0;
    render(
      <QuestionImport
        workspaceId={WS}
        readOnly={null}
        initialRun={{ ...RUN, draft_count: TOTAL }}
        initialDrafts={Array.from({ length: TOTAL }, (_, i) => draft(i))}
        loadFailed={false}
      />,
    );
    const user = userEvent.setup();
    const list = () => screen.getByRole('list', { name: '가져온 초안' });
    const items = () => within(list()).getAllByRole('listitem');
    const one = (n: number) => screen.getByRole('checkbox', { name: `${n}번 문제 선택` });
    const publishButton = () => screen.getByRole('button', { name: /선택한 문제 승인 및 등록/ });
    const heading = screen.getByRole('heading', { name: /가져온 초안/ });

    // Bounded rendering; the counts are over every draft.
    expect(items()).toHaveLength(DRAFT_PAGE_SIZE);
    expect(chapterRenders.count).toBe(DRAFT_PAGE_SIZE);
    expect(heading.textContent).toContain(`${TOTAL}개`);
    const all = screen.getByRole('checkbox', { name: `전체 선택 (${TOTAL}개)` });
    const pagers = screen.getAllByRole('navigation', { name: /초안 페이지/ });
    expect(pagers).toHaveLength(2);
    const [top, bottom] = pagers as [HTMLElement, HTMLElement];
    expect(within(top).getByText(`초안 1–${DRAFT_PAGE_SIZE} / ${TOTAL}개`)).toBeTruthy();
    expect(within(top).getByRole('button', { name: '1페이지' }).getAttribute('aria-current')).toBe(
      'page',
    );

    await user.click(all);
    expect(publishButton().textContent).toContain(`(${TOTAL})`);
    expect(screen.getByText(`선택 ${TOTAL}개`)).toBeTruthy();

    // The last page (drafts not rendered when 전체 선택 was clicked) is selected too.
    await user.click(within(top).getByRole('button', { name: '10페이지' }));
    expect(within(top).getByRole('button', { name: '10페이지' })).toBe(document.activeElement);
    expect(items()).toHaveLength(DRAFT_PAGE_SIZE);
    expect(one(TOTAL).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('checkbox', { name: '1번 문제 선택' })).toBeNull();
    // 다음 at the last page stays focusable and does nothing.
    const next = within(top).getByRole('button', { name: '다음' });
    expect(next.getAttribute('aria-disabled')).toBe('true');
    await user.click(next);
    expect(one(TOTAL)).toBeTruthy();

    // A draft unchecked on one page stays unchecked after paging away and back.
    await user.click(one(950));
    expect(publishButton().textContent).toContain(`(${TOTAL - 1})`);
    expect(all.getAttribute('aria-checked')).toBe('mixed');

    // The pager below the list moves focus to the list heading on the new page.
    await user.click(within(bottom).getByRole('button', { name: '이전' }));
    expect(document.activeElement).toBe(heading);
    expect(within(top).getByText(`초안 801–900 / ${TOTAL}개`)).toBeTruthy();
    await user.click(within(top).getByRole('button', { name: '다음' }));
    expect(one(950).getAttribute('aria-checked')).toBe('false');

    // The registration sends the whole selection, not the page.
    await user.click(publishButton());
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.drafts).toHaveLength(TOTAL - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
