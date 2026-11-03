// QIMPORT-02 `검토할 PDF` list (docs/screens/questions-import-layout.md; UX6-UPLOAD's switcher before
// UX9): one review per PDF — its newest extraction — so the import page lists the PDFs to review
// on the left. Pure: the page's server render reads the documents and the newest runs, the screen
// re-reads them while a row is in progress, and both hand them here.
import type { DocumentKind, DocumentSummary } from '@/lib/documents/client-api';
import { documentKind } from '@/lib/documents/upload-machine';
import type { ImportRegistration, ImportRun } from './drafts';

/** How many runs order the list and give its counts (the API's maximum page). */
export const REVIEW_RUNS = 200;

export interface ReviewPdf {
  readonly documentId: string;
  readonly title: string;
  readonly kind: DocumentKind | null;
  readonly document: DocumentSummary;
  /** The PDF has an extraction (the document list's `latest_import_id`). */
  readonly extracted: boolean;
  /** Its newest run when it is among the runs read (null without one or beyond that page). */
  readonly run: ImportRun | null;
}

type RunRef = Pick<ImportRun, 'source_document_id'> & Partial<ImportRun>;

/** A 문제지 / 교재+문제 waits for its extraction even without a run (QIMPORT-02, D1). */
function hasQuestions(doc: DocumentSummary): boolean {
  const kind = documentKind(doc);
  return kind === 'question_paper' || kind === 'mixed';
}

/**
 * The PDFs to review: every listed PDF with an extraction (membership from each document's
 * `latest_import_id`, never from a page of runs, which can miss older ones — Codex P2) and every
 * 문제지 / 교재+문제 without one (processing, failed or waiting for 문제 추출). A 교재 without an
 * extraction is not listed. Order: by the newest run in `runs` (newest first, as the API lists
 * them); extracted PDFs whose runs are all older than that page next, then the PDFs without an
 * extraction, each newest upload first.
 */
export function reviewPdfs(
  runs: readonly RunRef[],
  documents: readonly DocumentSummary[],
): ReviewPdf[] {
  const rank = new Map<string, number>();
  const newest = new Map<string, ImportRun>();
  for (const [index, run] of runs.entries()) {
    const id = run.source_document_id;
    if (!id || rank.has(id)) continue;
    rank.set(id, index);
    if (run.id) newest.set(id, run as ImportRun);
  }
  const tier = (d: DocumentSummary) => (!d.latest_import_id ? 2 : rank.has(d.id) ? 0 : 1);
  const ranked = (d: DocumentSummary) => rank.get(d.id) ?? 0;
  return documents
    .filter((d) => Boolean(d.latest_import_id) || hasQuestions(d))
    .sort(
      (a, b) =>
        tier(a) - tier(b) || ranked(a) - ranked(b) || b.created_at.localeCompare(a.created_at),
    )
    .map((d) => ({
      documentId: d.id,
      title: d.title,
      kind: documentKind(d),
      document: d,
      extracted: Boolean(d.latest_import_id),
      run: d.latest_import_id ? (newest.get(d.id) ?? null) : null,
    }));
}

/** What a row says about its PDF (state as text, never colour alone). */
export type ReviewPdfState =
  | { readonly kind: 'processing' }
  | { readonly kind: 'processingFailed' }
  | { readonly kind: 'extracting'; readonly value?: number }
  | { readonly kind: 'registering'; readonly processed: number; readonly total: number }
  | { readonly kind: 'drafts'; readonly drafts: number; readonly registered: number }
  | { readonly kind: 'extractFailed' }
  | { readonly kind: 'notExtracted' }
  | { readonly kind: 'extracted' };

export interface ReviewPdfLive {
  /** Percent of the running extraction jobs, by run id. */
  readonly extraction?: ReadonlyMap<string, number | undefined>;
  /** Registrations followed on this page, by run id (QIMP-JOB). */
  readonly registrations?: ReadonlyMap<string, ImportRegistration>;
}

export function reviewPdfState(pdf: ReviewPdf, live: ReviewPdfLive = {}): ReviewPdfState {
  const status = pdf.document.status;
  if (status === 'uploading' || status === 'processing') return { kind: 'processing' };
  if (status === 'failed') return { kind: 'processingFailed' };
  if (!pdf.extracted) return { kind: 'notExtracted' };
  const run = pdf.run;
  if (!run) return { kind: 'extracted' };
  const registration = live.registrations?.get(run.id);
  if (registration && (registration.status === 'queued' || registration.status === 'running')) {
    return { kind: 'registering', processed: registration.processed, total: registration.total };
  }
  if (run.status === 'queued' || run.status === 'running') {
    const value = live.extraction?.get(run.id);
    return value === undefined ? { kind: 'extracting' } : { kind: 'extracting', value };
  }
  if (run.status === 'failed' || run.status === 'cancelled') return { kind: 'extractFailed' };
  return { kind: 'drafts', drafts: run.draft_count, registered: run.published_count };
}

/** "초안 3개 · 등록 1개", "문제 추출 중 40%", "등록 중 2/5", "추출 전", "처리 실패" … */
export function reviewPdfStateText(state: ReviewPdfState): string {
  switch (state.kind) {
    case 'processing':
      return '처리 중';
    case 'processingFailed':
      return '처리 실패';
    case 'extracting':
      return state.value === undefined ? '문제 추출 중' : `문제 추출 중 ${state.value}%`;
    case 'registering':
      return `등록 중 ${state.processed}/${state.total}`;
    case 'drafts':
      return `초안 ${state.drafts}개 · 등록 ${state.registered}개`;
    case 'extractFailed':
      return '추출 실패';
    case 'notExtracted':
      return '추출 전';
    case 'extracted':
      return '추출 완료';
  }
}

/** Something on the list is still moving: the screen re-reads it (like 문서 관리). */
export function reviewPdfsInProgress(pdfs: readonly ReviewPdf[]): boolean {
  return pdfs.some((pdf) => {
    const state = reviewPdfState(pdf);
    return state.kind === 'processing' || state.kind === 'extracting';
  });
}
