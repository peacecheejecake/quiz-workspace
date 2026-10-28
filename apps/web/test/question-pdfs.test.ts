// QIMPORT-01-AC05/AC06 문제 PDF 관리 rows and actions (UX6-UPLOAD: every PDF with questions, and
// the same actions in 문서 관리): whether a PDF already has an import comes from the document
// list's per-document `latest_import_id`, never from a (truncated) list of the workspace's runs
// (Codex P2: a paper whose run is older than the newest 200 runs was offered 문제 추출 again and
// viewers lost 문제 검토).
import { describe, expect, it, vi } from 'vitest';
import type { DocumentSummary } from '../src/lib/documents/client-api';
import { buildRows, newUploadItem } from '../src/lib/documents/upload-machine';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const { questionPdfRows, questionPdfAction } =
  await import('../src/components/questions/import/question-pdfs');

const AT = '2026-10-21T00:00:00Z';

function paper(id: string, extra: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id,
    workspace_id: 'ws',
    document_type: 'question_paper',
    kind: 'question_paper',
    title: `문제지 ${id}`,
    filename: `${id}.pdf`,
    size_bytes: 100,
    sha256: 'a'.repeat(64),
    status: 'ready',
    active_revision_id: `rev-${id}`,
    last_error: null,
    created_at: AT,
    updated_at: AT,
    processing_job: null,
    ...extra,
  };
}

const book = (id: string, extra: Partial<DocumentSummary> = {}) =>
  paper(id, { document_type: 'book', kind: 'book', title: `교재 ${id}`, ...extra });

describe('questionPdfRows', () => {
  it('lists 문제지, 교재+문제 and extracted PDFs; a plain 교재 and unclassified PDFs stay out', () => {
    const rows = questionPdfRows(
      buildRows(
        [
          paper('p'),
          book('m', { kind: 'mixed' }),
          book('b'),
          book('extracted', { latest_import_id: 'run-x' }),
          book('analysing', { kind: null, status: 'processing' }),
        ],
        [],
      ),
    );
    expect(rows.map((r) => r.documentId)).toEqual(['p', 'm', 'extracted']);
  });
});

describe('questionPdfAction', () => {
  // 250 papers, each with its own run: any fixed window of runs would miss some of them.
  const docs = Array.from({ length: 250 }, (_, i) =>
    paper(`d${i}`, { latest_import_id: `run-${i}` }),
  );
  const rows = questionPdfRows(
    buildRows([...docs, paper('fresh', { latest_import_id: null })], []),
  );

  it('offers 문제 검토 for every PDF whose document reports an import', () => {
    const imported = rows.filter((r) => r.documentId !== 'fresh');
    expect(imported).toHaveLength(250);
    for (const row of imported) {
      expect(questionPdfAction(row, true)).toBe('review');
      expect(questionPdfAction(row, false)).toBe('review');
    }
  });

  it('offers 문제 추출 to editors only for a ready PDF with questions without an import', () => {
    const fresh = rows.find((r) => r.documentId === 'fresh');
    expect(fresh && questionPdfAction(fresh, true)).toBe('extract');
    expect(fresh && questionPdfAction(fresh, false)).toBeNull();
    const [mixed] = buildRows([book('m', { kind: 'mixed', latest_import_id: null })], []);
    expect(mixed && questionPdfAction(mixed, true)).toBe('extract');
  });

  it('offers nothing for a plain 교재 without an extraction, and 문제 검토 once it has one', () => {
    const [plain] = buildRows([book('b', { latest_import_id: null })], []);
    expect(plain && questionPdfAction(plain, true)).toBeNull();
    const [extracted] = buildRows([book('b', { latest_import_id: 'run-b' })], []);
    expect(extracted && questionPdfAction(extracted, false)).toBe('review');
  });

  it('offers nothing while a PDF is not ready or not listed by the server yet', () => {
    const [processing] = buildRows([paper('p', { status: 'processing' })], []);
    expect(processing && questionPdfAction(processing, true)).toBeNull();
    const file = new File(['%PDF-'], 'q.pdf', { type: 'application/pdf' });
    const local = {
      ...newUploadItem('l1', file, 'q', 'question_paper'),
      documentId: 'unlisted',
      phase: 'ready' as const,
    };
    const [row] = buildRows([], [local]);
    expect(row && questionPdfAction(row, true)).toBeNull();
  });
});
