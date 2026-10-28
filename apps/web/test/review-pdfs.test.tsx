// @vitest-environment jsdom
// QIMPORT-01 `검토할 PDF` (UX6-UPLOAD): one review per PDF, newest extraction first, and the import
// page uploads nothing — without an extraction it points at 문서 관리.
import './dom-setup';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentSummary } from '../src/lib/documents/client-api';
import type { ImportRun } from '../src/lib/questions/drafts';
import { reviewPdfs } from '../src/lib/questions/review-pdfs';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../src/components/questions/import/source-compare-panel', () => ({
  SourceComparePanel: () => null,
}));
const { QuestionImport, reviewPdfLabel, showsPdfSwitcher } =
  await import('../src/components/questions/import/question-import');

const WS = '55555555-5555-4555-8555-555555555555';
const A = '33333333-3333-4333-8333-333333333331';
const B = '33333333-3333-4333-8333-333333333332';
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
  ...extra,
});

const RUN: ImportRun = {
  id: '22222222-2222-4222-8222-222222222222',
  workspace_id: WS,
  status: 'succeeded',
  job_id: null,
  error_code: null,
  source_document_id: B,
  source_document_revision_id: null,
  document_title: '교재 B',
  draft_count: 0,
  published_count: 0,
  registration_job_id: null,
  created_at: AT,
  updated_at: AT,
  finished_at: AT,
};

describe('reviewPdfs', () => {
  it('keeps one entry per PDF in the order of its newest run and skips PDFs that are gone', () => {
    const runs = [
      { source_document_id: B },
      { source_document_id: A },
      { source_document_id: B },
      { source_document_id: 'deleted' },
      { source_document_id: null },
    ];
    const pdfs = reviewPdfs(runs, [
      doc(A, '문제지 A', 'question_paper'),
      doc(B, '교재 B', 'mixed'),
    ]);
    expect(pdfs).toEqual([
      { documentId: B, title: '교재 B', kind: 'mixed' },
      { documentId: A, title: '문제지 A', kind: 'question_paper' },
    ]);
    expect(pdfs.map(reviewPdfLabel)).toEqual(['교재 B · 교재+문제', '문제지 A · 문제지']);
    expect(showsPdfSwitcher(pdfs)).toBe(true);
    expect(showsPdfSwitcher(pdfs.slice(0, 1))).toBe(false);
  });
});

describe('reviewPdfs beyond one page of runs (Codex P2)', () => {
  it('offers every PDF whose document has an extraction, older ones after the page, never a PDF without one', () => {
    // 200 runs (the page the server reads) all belong to newer PDFs; OLD's run is not among them.
    const newer = Array.from({ length: 200 }, (_, i) =>
      doc(`n${i}`, `새 문제지 ${i}`, 'question_paper', {
        created_at: `2026-10-28T01:${String(i % 60).padStart(2, '0')}:00Z`,
      }),
    );
    const runs = newer.map((d) => ({ source_document_id: d.id }));
    const old = doc('old', '오래된 문제지', 'question_paper', {
      created_at: '2026-01-01T00:00:00Z',
    });
    const plain = doc('plain', '교재', 'book', { latest_import_id: null });
    const pdfs = reviewPdfs(runs, [old, plain, ...newer]);
    expect(pdfs).toHaveLength(201);
    expect(pdfs.slice(0, 200).map((p) => p.documentId)).toEqual(newer.map((d) => d.id));
    expect(pdfs[200]).toEqual({
      documentId: 'old',
      title: '오래된 문제지',
      kind: 'question_paper',
    });
    expect(pdfs.some((p) => p.documentId === 'plain')).toBe(false);
    // Without the runs (their read failed) the extracted PDFs are still all offered.
    expect(reviewPdfs([], [old, plain, ...newer])).toHaveLength(201);
  });

  it('keeps the opened PDF selected in `검토할 PDF` even when its run is not in the newest page', () => {
    render(
      <QuestionImport
        workspaceId={WS}
        readOnly={null}
        initialRun={{ ...RUN, source_document_id: A, document_title: '오래된 문제지' }}
        initialDrafts={[]}
        documentId={A}
        reviewPdfs={reviewPdfs(
          [{ source_document_id: B }],
          [doc(B, '교재 B', 'mixed'), doc(A, '오래된 문제지', 'question_paper')],
        )}
        loadFailed={false}
      />,
    );
    expect(screen.getByRole('combobox', { name: '검토할 PDF' }).textContent).toContain(
      '오래된 문제지 · 문제지',
    );
  });
});

describe('QuestionImport without uploads', () => {
  it('switches the reviewed PDF with `검토할 PDF` (two extracted PDFs) and has no upload', async () => {
    push.mockClear();
    const user = userEvent.setup();
    render(
      <QuestionImport
        workspaceId={WS}
        readOnly={null}
        initialRun={RUN}
        initialDrafts={[]}
        reviewPdfs={[
          { documentId: B, title: '교재 B', kind: 'mixed' },
          { documentId: A, title: '문제지 A', kind: 'question_paper' },
        ]}
        loadFailed={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /PDF (업로드|선택)/ })).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    const switcher = screen.getByRole('combobox', { name: '검토할 PDF' });
    expect(switcher.textContent).toContain('교재 B · 교재+문제');
    await user.click(switcher);
    await user.click(await screen.findByRole('option', { name: '문제지 A · 문제지' }));
    expect(push).toHaveBeenCalledWith(`/workspaces/${WS}/questions/import?document=${A}`);
  });

  it('without an extraction it says so and offers editors 문서 관리 열기; no switcher for one PDF', () => {
    const { unmount } = render(
      <QuestionImport
        workspaceId={WS}
        readOnly={null}
        initialRun={null}
        initialDrafts={[]}
        loadFailed={false}
      />,
    );
    expect(screen.getByRole('heading', { name: '추출된 문제가 없습니다' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '문서 관리 열기' }).getAttribute('href')).toBe(
      `/workspaces/${WS}?panel=documents`,
    );
    unmount();
    render(
      <QuestionImport
        workspaceId={WS}
        readOnly="viewer"
        initialRun={RUN}
        initialDrafts={[]}
        reviewPdfs={[{ documentId: B, title: '교재 B', kind: 'mixed' }]}
        loadFailed={false}
      />,
    );
    expect(screen.queryByRole('combobox', { name: '검토할 PDF' })).toBeNull();
    expect(screen.queryByRole('link', { name: '문서 관리 열기' })).toBeNull();
  });
});
