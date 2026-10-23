// QIMPORT-01 문제 PDF 가져오기 (docs/screens/questions-import.md). The workspace layout already
// resolved access (404 for unknown/foreign workspaces); this page loads the newest import run (of
// the `?document=` question paper when given, QIMPORT-01-AC06) and its drafts server-side and hands them to the client screen, which runs uploads, the import job
// and the review through the same-origin relays (src/app/api).
import type { Metadata } from 'next';
import { QuestionImport } from '@/components/questions/import/question-import';
import { loadLatestImport } from '@/lib/questions/import-data';
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
  const [workspace, data] = await Promise.all([
    requireWorkspace(id),
    loadLatestImport(id, documentId),
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
        documentId={documentId}
        loadFailed={data.loadFailed}
      />
    </div>
  );
}
