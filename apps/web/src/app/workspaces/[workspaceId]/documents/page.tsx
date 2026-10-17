// DOC-01 Documents 목록·PDF 업로드 (docs/screens/documents-library.md). The first list comes from
// FastAPI server-side; uploads and live status run in the client (DocumentsLibrary).
import type { Metadata } from 'next';
import { unstable_rethrow } from 'next/navigation';
import { DocumentsLibrary } from '@/components/documents/documents-library';
import { loadDocuments, type DocumentSummary } from '@/lib/documents/data';
import { requireWorkspace } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: '문서' };

export default async function Page({
  params,
}: Readonly<{ params: Promise<{ workspaceId: string }> }>) {
  const { workspaceId } = await params;
  const workspace = await requireWorkspace(workspaceId);
  let documents: DocumentSummary[] = [];
  let loadFailed = false;
  try {
    documents = await loadDocuments(workspace.id);
  } catch (error) {
    unstable_rethrow(error);
    loadFailed = true;
  }

  const archived = workspace.status === 'archived';
  const viewer = workspace.role === 'viewer';
  const canEdit = !archived && !viewer;
  // The archived banner comes from the workspace layout; viewers get their own note here.
  const readOnlyReason =
    viewer && !archived ? '뷰어 권한으로는 문서를 볼 수만 있습니다.' : undefined;

  return (
    <div data-screen-id="DOC-01">
      <DocumentsLibrary
        key={workspace.id}
        workspaceId={workspace.id}
        initialDocuments={documents}
        canEdit={canEdit}
        readOnlyReason={readOnlyReason}
        loadFailed={loadFailed}
      />
    </div>
  );
}
