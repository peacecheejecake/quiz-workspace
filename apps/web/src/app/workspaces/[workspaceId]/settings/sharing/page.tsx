// WS-SHARE-01 Owner 공유 관리 (docs/screens/workspace-sharing.md). The workspace layout already
// resolved access (404 for unknown, foreign and deleted workspaces); the share-link list is read
// server-side through the Bearer helper and holds metadata only — never a secret.
import type { Metadata } from 'next';
import { SharingScreen } from '@/components/sharing/sharing-screen';
import { loadShareLinks } from '@/lib/sharing/data';
import { requireWorkspace } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: '공유 설정', referrer: 'no-referrer' };

export default async function Page({
  params,
}: Readonly<{ params: Promise<{ workspaceId: string }> }>) {
  const { workspaceId } = await params;
  const [workspace, load] = await Promise.all([
    requireWorkspace(workspaceId),
    loadShareLinks(workspaceId),
  ]);

  return (
    <div data-screen-id="WS-SHARE-01">
      <SharingScreen
        workspace={{
          id: workspace.id,
          name: workspace.name,
          archived: workspace.status === 'archived',
        }}
        load={load}
      />
    </div>
  );
}
