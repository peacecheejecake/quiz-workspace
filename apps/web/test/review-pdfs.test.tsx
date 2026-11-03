// @vitest-environment jsdom
// QIMPORT-02 `검토할 PDF` (docs/screens/questions-import-layout.md): the PDFs to review — every PDF
// with an extraction and every 문제지 / 교재+문제 waiting for one, newest extraction first — their
// state as text, and the import page's two panes: the list replaces UX6-UPLOAD's switcher, a row
// pushes `?document=`, a switch with checked drafts asks first.
import './dom-setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentSummary } from '../src/lib/documents/client-api';
import {
  reviewDraftFromImport,
  type ImportDraft,
  type ImportRegistration,
  type ImportRun,
} from '../src/lib/questions/drafts';
import {
  reviewPdfs,
  reviewPdfsInProgress,
  reviewPdfState,
  reviewPdfStateText,
} from '../src/lib/questions/review-pdfs';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../src/components/questions/import/source-compare-panel', () => ({
  SourceComparePanel: () => null,
}));
const { ImportReviewLayout } =
  await import('../src/components/questions/import/import-review-layout');

const WS = '55555555-5555-4555-8555-555555555555';
const A = '33333333-3333-4333-8333-333333333331';
const B = '33333333-3333-4333-8333-333333333332';
const C = '33333333-3333-4333-8333-333333333333';
const AT = '2026-10-28T00:00:00Z';

const doc = (
  id: string,
  title: string,
  kind: DocumentSummary['kind'],
  extra: Partial<DocumentSummary> = {},
): DocumentSummary => ({
  id,
  workspace_id: WS,
  document_type: kind === 'question_paper' ? 'question_paper' : 'book',
  kind,
  kind_source: 'auto',
  title,
  filename: `${title}.pdf`,
  size_bytes: 1,
  sha256: 'a'.repeat(64),
  status: 'ready',
  active_revision_id: `rev-${id}`,
  last_error: null,
  created_at: AT,
  updated_at: AT,
  latest_import_id: `run-${id}`,
  processing_job: null,
  question_count: 0,
  ...extra,
});

const run = (documentId: string, extra: Partial<ImportRun> = {}): ImportRun => ({
  id: `run-${documentId}`,
  workspace_id: WS,
  status: 'succeeded',
  job_id: null,
  error_code: null,
  source_document_id: documentId,
  source_document_revision_id: null,
  document_title: null,
  draft_count: 3,
  published_count: 1,
  registration_job_id: null,
  created_at: AT,
  updated_at: AT,
  finished_at: AT,
  ...extra,
});

function nth<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
}

const first = <T,>(list: readonly T[]): T => nth(list, 0);

describe('reviewPdfs', () => {
  it('lists extracted PDFs by their newest run, then PDFs with questions waiting, never a plain 교재', () => {
    const runs = [
      run(B),
      run(A),
      run(B, { id: 'older-b' }),
      { source_document_id: 'deleted' },
      { source_document_id: null },
    ];
    const pdfs = reviewPdfs(runs, [
      doc(A, '문제지 A', 'question_paper'),
      doc(B, '교재 B', 'mixed'),
      doc(C, '교재+문제 C', 'mixed', {
        latest_import_id: null,
        created_at: '2026-10-29T00:00:00Z',
      }),
      doc('d', '처리 중 D', 'question_paper', {
        latest_import_id: null,
        status: 'processing',
        created_at: '2026-10-30T00:00:00Z',
      }),
      doc('e', '교재 E', 'book', { latest_import_id: null }),
    ]);
    expect(pdfs.map((p) => p.title)).toEqual(['교재 B', '문제지 A', '처리 중 D', '교재+문제 C']);
    expect(pdfs[0]?.run?.id).toBe(`run-${B}`);
    expect(pdfs.map((p) => reviewPdfStateText(reviewPdfState(p)))).toEqual([
      '초안 3개 · 등록 1개',
      '초안 3개 · 등록 1개',
      '처리 중',
      '추출 전',
    ]);
    expect(reviewPdfsInProgress(pdfs)).toBe(true);
    expect(reviewPdfsInProgress(pdfs.slice(0, 2))).toBe(false);
  });

  it('offers every PDF whose document has an extraction, older ones after the page of runs (Codex P2)', () => {
    const newer = Array.from({ length: 200 }, (_, i) =>
      doc(`n${i}`, `새 문제지 ${i}`, 'question_paper', {
        created_at: `2026-10-28T01:${String(i % 60).padStart(2, '0')}:00Z`,
      }),
    );
    const runs = newer.map((d) => ({ source_document_id: d.id }));
    const old = doc('old', '오래된 문제지', 'question_paper', {
      created_at: '2026-01-01T00:00:00Z',
    });
    const waiting = doc('wait', '추출 전 문제지', 'question_paper', {
      latest_import_id: null,
      created_at: '2026-12-01T00:00:00Z',
    });
    const pdfs = reviewPdfs(runs, [waiting, old, ...newer]);
    expect(pdfs).toHaveLength(202);
    expect(pdfs.slice(0, 200).map((p) => p.documentId)).toEqual(newer.map((d) => d.id));
    expect(pdfs[200]?.documentId).toBe('old');
    expect(reviewPdfStateText(reviewPdfState(nth(pdfs, 200)))).toBe('추출 완료');
    expect(pdfs[201]?.documentId).toBe('wait');
    // Without the runs (their read failed) every PDF is still listed.
    expect(reviewPdfs([], [waiting, old, ...newer])).toHaveLength(202);
  });

  it('says what a row is doing: extracting, registering, failed', () => {
    const extracting = first(
      reviewPdfs([run(A, { status: 'running', job_id: 'job-a' })], [doc(A, 'A', 'question_paper')]),
    );
    expect(reviewPdfStateText(reviewPdfState(extracting))).toBe('문제 추출 중');
    expect(
      reviewPdfStateText(reviewPdfState(extracting, { extraction: new Map([[`run-${A}`, 40]]) })),
    ).toBe('문제 추출 중 40%');
    const done = first(reviewPdfs([run(A)], [doc(A, 'A', 'question_paper')]));
    const registering: ImportRegistration = {
      import_id: `run-${A}`,
      job_id: 'reg',
      status: 'running',
      total: 5,
      processed: 2,
      registered: 2,
      skipped: 0,
      refused: [],
      error_code: null,
      created_at: AT,
      finished_at: null,
    };
    expect(
      reviewPdfStateText(
        reviewPdfState(done, { registrations: new Map([[`run-${A}`, registering]]) }),
      ),
    ).toBe('등록 중 2/5');
    const failed = first(
      reviewPdfs([run(A, { status: 'failed' })], [doc(A, 'A', 'question_paper')]),
    );
    expect(reviewPdfStateText(reviewPdfState(failed))).toBe('추출 실패');
    const broken = first(
      reviewPdfs([], [doc(A, 'A', 'question_paper', { status: 'failed', latest_import_id: null })]),
    );
    expect(reviewPdfStateText(reviewPdfState(broken))).toBe('처리 실패');
  });
});

function draft(i: number): ImportDraft {
  return {
    id: `d-${i}`,
    import_id: `run-${A}`,
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
    created_at: AT,
    updated_at: AT,
    chapter: null,
    chapter_choice: 'auto',
    chapter_match: 'no_match',
    source_chapter_title: null,
    payload: {
      schema_version: 1,
      id: `${A}-q${i}`,
      origin: 'pdf_import',
      question_type: 'SHORT_ANSWER',
      stem: `문제 본문 ${i}`,
      options: [],
      correct_option_ids: null,
      accepted_answers: ['답'],
      evidence: [{ document_id: A, locations: [{ page: 1 }] }],
      validations: [],
      review_status: 'pending',
    },
  } as ImportDraft;
}

function layout(readOnly: 'viewer' | null = null) {
  const drafts = [0, 1].map((i) => reviewDraftFromImport(draft(i)));
  return (
    <ImportReviewLayout
      workspaceId={WS}
      workspaceName="연습 Workspace"
      readOnly={readOnly}
      documents={[
        doc(A, '문제지 A', 'question_paper'),
        doc(B, '교재 B', 'mixed'),
        doc(C, '교재+문제 C', 'mixed', { latest_import_id: null }),
      ]}
      runs={[run(A, { draft_count: 2, published_count: 0 }), run(B)]}
      listFailed={false}
      documentId={A}
      review={{
        run: run(A, { draft_count: 2, published_count: 0 }),
        drafts,
        summaries: drafts,
        chapters: [],
        loadedAt: AT,
        loadFailed: false,
      }}
    />
  );
}

describe('ImportReviewLayout (QIMPORT-02)', () => {
  it('shows the list in a nav beside the review titled by the PDF, without the old switcher', () => {
    render(layout());
    expect(screen.getByRole('heading', { level: 1, name: '문제 PDF 가져오기' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: '검토할 PDF' });
    expect(within(nav).getByRole('heading', { level: 2, name: '검토할 PDF (3)' })).toBeTruthy();
    const rows = within(nav).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('문제지 A'),
      expect.stringContaining('교재 B'),
      expect.stringContaining('교재+문제 C'),
    ]);
    expect(rows[0]?.textContent).toContain('초안 2개 · 등록 0개');
    expect(rows[2]?.textContent).toContain('추출 전');
    expect(
      within(nth(rows, 2)).getByRole('button', { name: '교재+문제 C 문제 추출' }),
    ).toBeTruthy();
    const current = within(nav).getByRole('link', { name: '문제지 A' });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: '교재 B' }).getAttribute('href')).toBe(
      `/workspaces/${WS}/questions/import?document=${B}`,
    );
    const review = screen.getByRole('region', { name: '문제지 A' });
    expect(within(review).getByRole('heading', { level: 2, name: '문제지 A' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: '검토할 PDF' })).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('a row pushes ?document=; with checked drafts it asks first and 취소 keeps the PDF', async () => {
    router.push.mockClear();
    const user = userEvent.setup();
    render(layout());
    const nav = screen.getByRole('navigation', { name: '검토할 PDF' });
    await user.click(within(nav).getByRole('link', { name: '교재 B' }));
    expect(router.push).toHaveBeenCalledWith(`/workspaces/${WS}/questions/import?document=${B}`, {
      scroll: false,
    });
    router.push.mockClear();

    await user.click(screen.getByRole('checkbox', { name: '1번 문제 선택' }));
    await user.click(within(nav).getByRole('link', { name: '교재 B' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain(
      '선택한 초안 1개의 선택이 사라집니다. 다른 PDF로 바꿀까요?',
    );
    await user.click(within(confirm).getByRole('button', { name: '취소' }));
    expect(router.push).not.toHaveBeenCalled();
    expect(
      screen.getByRole('checkbox', { name: '1번 문제 선택' }).getAttribute('aria-checked'),
    ).toBe('true');
    await user.click(within(nav).getByRole('link', { name: '교재 B' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '바꾸기' }),
    );
    expect(router.push).toHaveBeenCalledWith(`/workspaces/${WS}/questions/import?document=${B}`, {
      scroll: false,
    });
  });

  it('a viewer sees the list and the review without 문제 추출 or registering', () => {
    render(layout('viewer'));
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /문제 추출/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /선택한 문제 승인 및 등록/ })).toBeNull();
  });

  it('a PDF not on the list is not found; no PDF to review shows the empty state only', () => {
    const { unmount } = render(
      <ImportReviewLayout
        workspaceId={WS}
        workspaceName="연습 Workspace"
        readOnly={null}
        documents={[doc(A, '문제지 A', 'question_paper')]}
        runs={[run(A)]}
        listFailed={false}
        documentId={B}
        notFound
        review={null}
      />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'PDF를 찾을 수 없습니다.' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: '검토할 PDF' })).toBeTruthy();
    unmount();
    render(
      <ImportReviewLayout
        workspaceId={WS}
        workspaceName="연습 Workspace"
        readOnly={null}
        documents={[doc('e', '교재 E', 'book', { latest_import_id: null })]}
        runs={[]}
        listFailed={false}
        documentId={null}
        review={null}
      />,
    );
    expect(screen.getByRole('heading', { name: '추출된 문제가 없습니다' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '문서 관리 열기' }).getAttribute('href')).toBe(
      `/workspaces/${WS}?panel=documents`,
    );
    expect(screen.queryByRole('navigation', { name: '검토할 PDF' })).toBeNull();
  });
});

describe('ImportReviewLayout switching to a PDF without an extraction (Codex P2)', () => {
  it('QIMPORT-02-AC03 the checked drafts of the PDF left behind never make the next switch ask', async () => {
    router.push.mockClear();
    const user = userEvent.setup();
    const { rerender } = render(layout());
    const nav = () => screen.getByRole('navigation', { name: '검토할 PDF' });
    await user.click(screen.getByRole('checkbox', { name: '1번 문제 선택' }));
    await user.click(within(nav()).getByRole('link', { name: '교재+문제 C' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '바꾸기' }),
    );
    expect(router.push).toHaveBeenCalledTimes(1);
    // The server renders C: no review pane (it has no extraction), so nothing is checked.
    rerender(
      <ImportReviewLayout
        workspaceId={WS}
        workspaceName="연습 Workspace"
        readOnly={null}
        documents={[
          doc(A, '문제지 A', 'question_paper'),
          doc(B, '교재 B', 'mixed'),
          doc(C, '교재+문제 C', 'mixed', { latest_import_id: null }),
        ]}
        runs={[run(A, { draft_count: 2, published_count: 0 }), run(B)]}
        listFailed={false}
        documentId={C}
        review={null}
      />,
    );
    expect(screen.getByText('아직 추출하지 않았습니다.')).toBeTruthy();
    await user.click(within(nav()).getByRole('link', { name: '교재 B' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(router.push).toHaveBeenLastCalledWith(
      `/workspaces/${WS}/questions/import?document=${B}`,
      { scroll: false },
    );
  });
});

describe('ImportReviewLayout retrying a failed extraction (Codex P2)', () => {
  it('QIMPORT-02-AC01 the row and the phone button follow the retried extraction, not "추출 실패"', async () => {
    const failed = run(A, { status: 'failed', job_id: 'job-1', error_code: 'extraction_failed' });
    const retried = run(A, { status: 'running', job_id: 'job-2', error_code: null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/retry')) return Response.json(retried);
        // The job runs on: its events never end here.
        if (url.includes('/api/jobs/')) return new Promise<Response>(() => undefined);
        return new Response('{}', { status: 404 });
      }),
    );
    try {
      const user = userEvent.setup();
      render(
        <ImportReviewLayout
          workspaceId={WS}
          workspaceName="연습 Workspace"
          readOnly={null}
          documents={[doc(A, '문제지 A', 'question_paper')]}
          runs={[failed]}
          listFailed={false}
          documentId={A}
          review={{
            run: failed,
            drafts: [],
            summaries: [],
            chapters: [],
            loadedAt: AT,
            loadFailed: false,
          }}
        />,
      );
      const nav = screen.getByRole('navigation', { name: '검토할 PDF' });
      const row = within(nav).getAllByRole('listitem')[0];
      expect(row?.textContent).toContain('추출 실패');
      await user.click(screen.getByRole('button', { name: '다시 시도' }));
      await waitFor(() =>
        expect(within(nav).getAllByRole('listitem')[0]?.textContent).toContain('문제 추출 중'),
      );
      expect(within(nav).getAllByRole('listitem')[0]?.textContent).not.toContain('추출 실패');
      const opener = document.querySelector('[aria-haspopup="dialog"]');
      expect(opener?.textContent).toContain('문제 추출 중');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
