// DOC-02 PDF 열람·원문 교정 (docs/screens/documents-editor.md). The workspace (role, archived) and
// the document are read server-side; the outline, text, PDF and publish flow run in the client
// (DocumentEditor) through the same-origin BFF.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocumentEditor } from '@/components/documents/editor/document-editor';
import { loadDocument } from '@/lib/documents/data';
import { parsePageParam, parseRevisionParam, pinnedRevisionFor } from '@/lib/documents/outline';
import { requireWorkspace } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: '문서 보기' };

const BLOCK_ID = /^\S{1,256}$/;

export default async function Page({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ workspaceId: string; documentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const [{ workspaceId, documentId }, query] = await Promise.all([params, searchParams]);
  const workspace = await requireWorkspace(workspaceId);
  const document = await loadDocument(workspace.id, documentId);
  if (!document || document.workspace_id !== workspace.id) notFound();

  const archived = workspace.status === 'archived';
  const viewer = workspace.role === 'viewer';
  const canEdit = !archived && !viewer;
  const readOnlyReason =
    viewer && !archived
      ? '뷰어 권한으로는 원문을 볼 수만 있고 수정·발행할 수 없습니다.'
      : undefined;
  const rawBlock = Array.isArray(query.block) ? query.block[0] : query.block;
  const pinnedRevisionId = pinnedRevisionFor(parseRevisionParam(query.revision), document, canEdit);

  return (
    <div data-screen-id="DOC-02">
      <DocumentEditor
        key={`${document.id}:${pinnedRevisionId ?? ''}`}
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        document={document}
        canEdit={canEdit}
        readOnlyReason={readOnlyReason}
        initialPage={parsePageParam(query.page)}
        initialBlockId={rawBlock && BLOCK_ID.test(rawBlock) ? rawBlock : null}
        pinnedRevisionId={pinnedRevisionId}
      />
    </div>
  );
}
