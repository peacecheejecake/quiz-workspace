// Frame for every workspace route. Access is checked server-side with `GET /workspaces/{id}`
// before anything renders: unknown, foreign and soft-deleted workspaces get the not-found page
// with HTTP 404 (no Suspense boundary sits above this layout, so the status is not yet sent).
import type { ReactNode } from 'react';
import { AuthenticatedShell } from '@/components/app-shell/authenticated-shell';
import { WorkspaceNav } from '@/components/workspaces/workspace-nav';
import { WorkspaceSwitcher } from '@/components/workspaces/workspace-switcher';
import styles from '@/components/workspaces/workspaces.module.css';
import { loadSwitcherWorkspaces, requireWorkspace } from '@/lib/workspaces/data';

export default async function WorkspaceLayout({
  children,
  params,
}: Readonly<{ children: ReactNode; params: Promise<{ workspaceId: string }> }>) {
  const { workspaceId } = await params;
  const [workspace, switchable] = await Promise.all([
    requireWorkspace(workspaceId),
    loadSwitcherWorkspaces(),
  ]);
  const current = { id: workspace.id, name: workspace.name, status: workspace.status };

  return (
    <AuthenticatedShell
      navLabel="Workspace 메뉴"
      headerContent={
        <WorkspaceSwitcher
          current={current}
          workspaces={switchable.map(({ id, name }) => ({ id, name }))}
        />
      }
      sidebar={<WorkspaceNav workspaceId={workspace.id} isOwner={workspace.role === 'owner'} />}
    >
      {workspace.status === 'archived' ? (
        <p role="note" className={styles.archivedBanner}>
          보관된 Workspace입니다. 읽기 전용이며, 소유자가 Workspace 홈에서 복원할 수 있습니다.
        </p>
      ) : null}
      {children}
    </AuthenticatedShell>
  );
}
