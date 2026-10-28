// QIMPORT-01 `검토할 PDF` (UX6-UPLOAD): one review per PDF — its newest extraction — so the import
// page switches between the PDFs that have one, newest extraction first. Pure: the page's server
// render reads the runs and the documents and hands the result over.
import type { DocumentKind, DocumentSummary } from '@/lib/documents/client-api';
import { documentKind } from '@/lib/documents/upload-machine';

export interface ReviewPdf {
  readonly documentId: string;
  readonly title: string;
  readonly kind: DocumentKind | null;
}

/**
 * The listed PDFs with an extraction, in the order of their newest run (`runs` newest first, as
 * the API lists them). Runs of PDFs that are gone (deleted, or not listed) are skipped.
 */
export function reviewPdfs(
  runs: readonly { readonly source_document_id: string | null }[],
  documents: readonly DocumentSummary[],
): ReviewPdf[] {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const seen = new Set<string>();
  const out: ReviewPdf[] = [];
  for (const run of runs) {
    const id = run.source_document_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const doc = byId.get(id);
    if (doc) out.push({ documentId: id, title: doc.title, kind: documentKind(doc) });
  }
  return out;
}
