// QBANK-01 문제은행 (docs/screens/questions-bank.md). The workspace layout already resolved access
// (404 for unknown/foreign workspaces); this page loads the bank under the URL filters through the
// server-side Bearer helper and hands it to the client screen.
import type { Metadata } from 'next';
import { QuestionBank } from '@/components/questions/question-bank';
import { loadBank } from '@/lib/questions/data';
import { parseBankFilters, wantsCreate } from '@/lib/questions/filters';
import { requireWorkspace } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: '문제은행' };

export default async function Page({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const filters = parseBankFilters(query);
  const [workspace, bank] = await Promise.all([
    requireWorkspace(workspaceId),
    loadBank(workspaceId, filters),
  ]);
  const readOnly =
    workspace.status === 'archived' ? 'archived' : workspace.role === 'viewer' ? 'viewer' : null;

  return (
    <div data-screen-id="QBANK-01">
      <QuestionBank
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        readOnly={readOnly}
        filters={filters}
        items={bank.items}
        nextCursor={bank.nextCursor}
        failure={bank.failure}
        chapters={bank.chapters}
        documents={bank.documents}
        openCreate={wantsCreate(query)}
      />
    </div>
  );
}
