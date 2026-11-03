// QIMPORT-01 문제 PDF 가져오기 (docs/screens/questions-import.md) in QIMPORT-02's two panes
// (questions-import-layout.md). The workspace layout already resolved access (404 for
// unknown/foreign workspaces); this page reads the `검토할 PDF` list (the documents and newest runs:
// summary fields only) and the review of the `?document=` PDF — its newest run and that run's
// drafts, no other PDF's — server-side and hands them to the client screen, which follows the
// import job and runs the review through the same-origin relays (src/app/api). Without
// `?document=` the list's first PDF (the newest extraction) is shown, its address written in place.
// A PDF that is not on the list (another workspace's, deleted, a 교재 without questions) is not
// found: nothing of it is read. Nothing is uploaded here since UX6-UPLOAD: PDFs are uploaded in
// 문서 관리.
import type { Metadata } from 'next';
import { ImportReviewLayout } from '@/components/questions/import/import-review-layout';
import { loadLatestImport, loadReviewList } from '@/lib/questions/import-data';
import { reviewPdfs } from '@/lib/questions/review-pdfs';
import { requireWorkspace, workspaceRouteId } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: '문제 PDF 가져오기' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const id = workspaceRouteId(workspaceId);
  const raw = typeof query.document === 'string' ? query.document : undefined;
  // A malformed id is not found like a foreign one.
  const documentId = raw === undefined ? undefined : UUID.test(raw) ? raw.toLowerCase() : null;
  const [workspace, list] = await Promise.all([requireWorkspace(id), loadReviewList(id)]);
  const pdfs = reviewPdfs(list.runs, list.documents);
  // Without `?document=` the list's first PDF (the newest extraction) is shown and the screen
  // writes its `?document=` in place (no history entry: Back leaves the page). Not a server
  // redirect: inside the route's loading boundary that would arrive as a client redirect after
  // an empty shell instead of the first page of drafts (QIMP-PAGING).
  const chosen = documentId === undefined && !list.failed ? pdfs[0]?.documentId : documentId;
  const selected = chosen ? pdfs.find((pdf) => pdf.documentId === chosen) : undefined;
  const notFound = !list.failed && documentId !== undefined && !selected;
  // The review is read for a listed PDF with an extraction; when the list could not be read, for
  // the asked PDF (or the newest run) as before — the API scopes both to this workspace.
  const review = list.failed
    ? await loadLatestImport(id, documentId ?? undefined)
    : selected?.extracted
      ? await loadLatestImport(id, selected.documentId)
      : null;
  const readOnly =
    workspace.status === 'archived' ? 'archived' : workspace.role === 'viewer' ? 'viewer' : null;

  return (
    <div data-screen-id="QIMPORT-01">
      <ImportReviewLayout
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        readOnly={readOnly}
        documents={list.documents}
        runs={list.runs}
        listFailed={list.failed}
        documentId={chosen ?? null}
        writeDocumentParam={documentId === undefined && chosen !== undefined}
        notFound={notFound}
        review={review}
      />
    </div>
  );
}
