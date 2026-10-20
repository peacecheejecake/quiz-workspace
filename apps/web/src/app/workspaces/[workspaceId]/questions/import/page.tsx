// QIMPORT-01 문제 PDF 가져오기 (docs/screens/questions-import.md). The workspace layout already
// resolved access (404 for unknown/foreign workspaces); this page loads the newest import run and
// its drafts server-side and hands them to the client screen, which runs uploads, the import job
// and the review through the same-origin relays (src/app/api).
import type { Metadata } from 'next';
import { QuestionImport } from '@/components/questions/import/question-import';
import { loadLatestImport } from '@/lib/questions/import-data';
import { requireWorkspace } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: '문제 PDF 가져오기' };

export default async function Page({
  params,
}: Readonly<{ params: Promise<{ workspaceId: string }> }>) {
  const { workspaceId } = await params;
  const workspace = await requireWorkspace(workspaceId);
  const data = await loadLatestImport(workspace.id);
  const readOnly =
    workspace.status === 'archived' ? 'archived' : workspace.role === 'viewer' ? 'viewer' : null;

  return (
    <div data-screen-id="QIMPORT-01">
      <QuestionImport
        key={workspace.id}
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        readOnly={readOnly}
        initialRun={data.run}
        initialDrafts={data.drafts}
        loadFailed={data.loadFailed}
      />
    </div>
  );
}
