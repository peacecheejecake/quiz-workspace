// UX3c: a workspace sub-page reached by a button (문제은행, 문제 PDF 가져오기, 문제 변형 출제,
// PDF 열람) shows a back link to the workspace home and a breadcrumb
// `Workspace 이름 › … › 현재 페이지` in its PageHeader `back`/`breadcrumb` slots.
import { BackLink, Breadcrumb, type BreadcrumbItem } from '@quiz/ui';
import Link from 'next/link';
import { workspaceHomePath } from '@/lib/workspaces/home';

export interface WorkspaceCrumb {
  readonly id: string;
  readonly name: string;
}

/** PageHeader `back`: to the workspace home. */
export function WorkspaceBackLink({ workspaceId }: { readonly workspaceId: string }) {
  return (
    <BackLink href={workspaceHomePath(workspaceId)} label="Workspace 홈" linkComponent={Link} />
  );
}

/** PageHeader `breadcrumb`: the workspace (home link), then `trail`, ending at this page. */
export function WorkspaceBreadcrumb({
  workspace,
  trail,
}: {
  readonly workspace: WorkspaceCrumb;
  readonly trail: readonly BreadcrumbItem[];
}) {
  return (
    <Breadcrumb
      linkComponent={Link}
      items={[{ label: workspace.name, href: workspaceHomePath(workspace.id) }, ...trail]}
    />
  );
}
