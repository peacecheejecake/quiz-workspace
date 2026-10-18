// WS-01 Workspace home (docs/screens/workspaces.md): Active/Archived tabs, create dialog and owner
// lifecycle actions. Data comes from FastAPI through the server-side Bearer helper.
import { Skeleton } from '@quiz/ui';
import type { Metadata } from 'next';
import { unstable_rethrow } from 'next/navigation';
import { Suspense } from 'react';
import { AuthenticatedShell } from '@/components/app-shell/authenticated-shell';
import { CreateWorkspaceProvider } from '@/components/workspaces/create-workspace';
import { WorkspaceLoadError } from '@/components/workspaces/workspace-load-error';
import { WorkspaceHomeHeader, WorkspaceTabs } from '@/components/workspaces/workspace-tabs';
import styles from '@/components/workspaces/workspaces.module.css';
import { loadWorkspaceLists, type WorkspaceLists } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: 'Workspace 홈' };

export default function Page() {
  return (
    <AuthenticatedShell>
      <CreateWorkspaceProvider>
        <div data-screen-id="WS-01">
          <Suspense fallback={<ListSkeleton />}>
            <WorkspaceListSection />
          </Suspense>
        </div>
      </CreateWorkspaceProvider>
    </AuthenticatedShell>
  );
}

async function WorkspaceListSection() {
  let lists: WorkspaceLists;
  try {
    lists = await loadWorkspaceLists();
  } catch (error) {
    // Redirects (expired session) and other Next control flow must propagate.
    unstable_rethrow(error);
    return (
      <>
        <WorkspaceHomeHeader withCreate />
        <WorkspaceLoadError />
      </>
    );
  }
  return <WorkspaceTabs active={lists.active} archived={lists.archived} />;
}

function ListSkeleton() {
  // Without the lists it is unknown whether the empty state will carry the create CTA.
  return (
    <>
      <WorkspaceHomeHeader withCreate={false} />
      <div aria-busy="true" className={styles.skeleton}>
        <p role="status" className="qz-visually-hidden">
          Workspace 목록을 불러오는 중입니다.
        </p>
        <Skeleton shape="rect" width="12rem" height="2.5rem" />
        <Skeleton shape="rect" height="4.5rem" />
        <Skeleton shape="rect" height="4.5rem" />
        <Skeleton shape="rect" height="4.5rem" />
      </div>
    </>
  );
}
