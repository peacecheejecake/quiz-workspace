// QIMPORT-01 문제 PDF 가져오기 (docs/screens/questions-import.md). The workspace layout already
// resolved access (404 for unknown/foreign workspaces); this page loads the newest import run (of
// the `?document=` PDF when given, QIMPORT-01-AC06), its drafts and the PDFs with an extraction
// (`검토할 PDF`, UX6-UPLOAD) server-side and hands them to the client screen, which follows the
// import job and runs the review through the same-origin relays (src/app/api). Nothing is
// uploaded here since UX6-UPLOAD: PDFs are uploaded in 문서 관리.
import type { Metadata } from 'next';
import { QuestionImport } from '@/components/questions/import/question-import';
import { loadLatestImport, loadReviewPdfs } from '@/lib/questions/import-data';
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
  // A malformed id is ignored (the newest run of the workspace is shown instead).
  const documentId =
    typeof query.document === 'string' && UUID.test(query.document) ? query.document : undefined;
  const [workspace, data, pdfs] = await Promise.all([
    requireWorkspace(id),
    loadLatestImport(id, documentId),
    loadReviewPdfs(id),
  ]);
  const readOnly =
    workspace.status === 'archived' ? 'archived' : workspace.role === 'viewer' ? 'viewer' : null;

  return (
    <div data-screen-id="QIMPORT-01">
      <QuestionImport
        key={`${workspace.id}:${documentId ?? ''}`}
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        readOnly={readOnly}
        initialRun={data.run}
        initialDrafts={data.drafts}
        initialChapters={data.chapters}
        loadedAt={data.loadedAt}
        documentId={documentId}
        reviewPdfs={pdfs}
        loadFailed={data.loadFailed}
      />
    </div>
  );
}
