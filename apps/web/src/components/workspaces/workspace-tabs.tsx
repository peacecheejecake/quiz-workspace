'use client';

// WS-01 Active/Archived tabs. The selected tab lives in the URL (`?status=archived`), updated
// with history.replaceState (Next syncs useSearchParams) so switching needs no server round
// trip: both lists arrive with the page and are refreshed after every mutation.
// The page header renders here too: its "Workspace 만들기" is hidden while the Active tab shows the
// empty state, whose CTA is then the only one (UX1, docs/screens/workspaces.md WS-01-AC01).
import type { Schemas } from '@quiz/api-client';
import { EmptyState, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@quiz/ui';
import { useSearchParams } from 'next/navigation';
import { CreateWorkspaceButton } from './create-workspace';
import { WorkspaceListItem } from './workspace-list-item';
import styles from './workspaces.module.css';

type Workspace = Schemas['Workspace'];
type Tab = 'active' | 'archived';

export function tabFromSearch(value: string | null): Tab {
  return value === 'archived' ? 'archived' : 'active';
}

export interface WorkspaceTabsProps {
  active: readonly Workspace[];
  archived: readonly Workspace[];
}

export function WorkspaceTabs({ active, archived }: WorkspaceTabsProps) {
  const tab = tabFromSearch(useSearchParams().get('status'));

  function select(value: string) {
    const next = tabFromSearch(value);
    window.history.replaceState(
      null,
      '',
      next === 'archived' ? '/workspaces?status=archived' : '/workspaces',
    );
  }

  const emptyStateCta = tab === 'active' && active.length === 0;

  return (
    <>
      <WorkspaceHomeHeader withCreate={!emptyStateCta} />
      <Tabs value={tab} onValueChange={select}>
        <TabsList aria-label="Workspace 상태">
          <TabsTrigger value="active">
            활성 <span className={styles.tabCount}>{active.length}</span>
          </TabsTrigger>
          <TabsTrigger value="archived">
            보관됨 <span className={styles.tabCount}>{archived.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="active">
          {active.length > 0 ? (
            <WorkspaceList label="활성 Workspace" items={active} />
          ) : (
            <EmptyState
              title={
                archived.length > 0 ? '활성 Workspace가 없습니다' : '아직 Workspace가 없습니다'
              }
              description="Workspace를 만들고 PDF를 올려 검색과 문제 풀이를 시작하세요."
              action={<CreateWorkspaceButton />}
            />
          )}
        </TabsContent>
        <TabsContent value="archived">
          {archived.length > 0 ? (
            <>
              <p className={styles.tabNote}>
                보관된 Workspace는 읽기 전용입니다. 복원하면 다시 수정할 수 있습니다.
              </p>
              <WorkspaceList label="보관된 Workspace" items={archived} />
            </>
          ) : (
            <EmptyState
              title="보관된 Workspace가 없습니다"
              description="보관한 Workspace는 읽기 전용으로 이곳에 모입니다."
            />
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

/** WS-01 page header; also used by the loading and error states of the page. */
export function WorkspaceHomeHeader({ withCreate }: { withCreate: boolean }) {
  return (
    <PageHeader title="Workspace" actions={withCreate ? <CreateWorkspaceButton /> : undefined} />
  );
}

function WorkspaceList({ label, items }: { label: string; items: readonly Workspace[] }) {
  return (
    <ul aria-label={label} className={styles.list}>
      {items.map((workspace) => (
        <WorkspaceListItem key={workspace.id} workspace={workspace} />
      ))}
    </ul>
  );
}
