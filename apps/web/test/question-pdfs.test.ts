// QIMPORT-01-AC06 문제 PDF 관리 row actions: whether a paper already has an import comes from the
// document list's per-document `latest_import_id`, never from a (truncated) list of the
// workspace's runs (Codex P2: a paper whose run is older than the newest 200 runs was offered
// 문제 추출 again and viewers lost 문제 검토).
import { describe, expect, it, vi } from 'vitest';
import type { DocumentSummary } from '../src/lib/documents/client-api';
import { buildRows, newUploadItem } from '../src/lib/documents/upload-machine';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const { questionPaperRows, questionPdfAction } =
  await import('../src/components/questions/import/question-pdfs');

const AT = '2026-10-21T00:00:00Z';

function paper(id: string, extra: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id,
    workspace_id: 'ws',
    document_type: 'question_paper',
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

describe('questionPdfAction', () => {
  // 250 papers, each with its own run: any fixed window of runs would miss some of them.
  const docs = Array.from({ length: 250 }, (_, i) =>
    paper(`d${i}`, { latest_import_id: `run-${i}` }),
  );
  const rows = questionPaperRows(
    buildRows([...docs, paper('fresh', { latest_import_id: null })], []),
  );

  it('offers 문제 검토 for every paper whose document reports an import', () => {
    const imported = rows.filter((r) => r.documentId !== 'fresh');
    expect(imported).toHaveLength(250);
    for (const row of imported) {
      expect(questionPdfAction(row, true)).toBe('review');
      expect(questionPdfAction(row, false)).toBe('review');
    }
  });

  it('offers 문제 추출 to editors only for a ready paper without an import', () => {
    const fresh = rows.find((r) => r.documentId === 'fresh');
    expect(fresh && questionPdfAction(fresh, true)).toBe('extract');
    expect(fresh && questionPdfAction(fresh, false)).toBeNull();
  });

  it('offers nothing while a paper is not ready or not listed by the server yet', () => {
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
