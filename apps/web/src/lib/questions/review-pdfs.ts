// QIMPORT-01 `검토할 PDF` (UX6-UPLOAD): one review per PDF — its newest extraction — so the import
// page switches between the PDFs that have one, newest extraction first. Pure: the page's server
// render reads the documents and the newest runs and hands the result over.
import type { DocumentKind, DocumentSummary } from '@/lib/documents/client-api';
import { documentKind } from '@/lib/documents/upload-machine';

export interface ReviewPdf {
  readonly documentId: string;
  readonly title: string;
  readonly kind: DocumentKind | null;
}

/**
 * The listed PDFs with an extraction. Membership comes from each document's `latest_import_id`
 * (the document list reports it for every PDF), never from a page of runs, which can miss older
 * ones (Codex P2). Order: by the newest run in `runs` (newest first, as the API lists them);
 * PDFs whose runs are all older than that page follow, newest document first.
 */
export function reviewPdfs(
  runs: readonly { readonly source_document_id: string | null }[],
  documents: readonly DocumentSummary[],
): ReviewPdf[] {
  const rank = new Map<string, number>();
  for (const [index, run] of runs.entries()) {
    const id = run.source_document_id;
    if (id && !rank.has(id)) rank.set(id, index);
  }
  const extracted = documents.filter((d) => Boolean(d.latest_import_id));
  const ranked = (d: DocumentSummary) => rank.get(d.id) ?? Number.POSITIVE_INFINITY;
  return [...extracted]
    .sort((a, b) => ranked(a) - ranked(b) || b.created_at.localeCompare(a.created_at))
    .map((d) => ({ documentId: d.id, title: d.title, kind: documentKind(d) }));
}
