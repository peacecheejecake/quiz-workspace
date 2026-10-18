// HISTORY-01 작업·변경·풀이 이력 (docs/screens/history-jobs.md). The workspace layout already
// resolved access (404 for unknown, foreign and deleted workspaces); the first page of each list is
// read server-side through the Bearer helper. "나" marks the verified user's own entries.
import type { Metadata } from 'next';
import { HistoryScreen } from '@/components/history/history-screen';
import { loadHistory } from '@/lib/history/data';
import { getVerifiedUser } from '@/lib/supabase/server';
import { requireWorkspace } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: '이력' };

export default async function Page({
  params,
}: Readonly<{ params: Promise<{ workspaceId: string }> }>) {
  const { workspaceId } = await params;
  const workspace = await requireWorkspace(workspaceId);
  const [initial, user] = await Promise.all([loadHistory(workspace.id), getVerifiedUser()]);

  return (
    <div data-screen-id="HISTORY-01">
      <HistoryScreen
        key={workspace.id}
        workspaceId={workspace.id}
        viewerId={user?.id ?? null}
        initial={initial}
      />
    </div>
  );
}
