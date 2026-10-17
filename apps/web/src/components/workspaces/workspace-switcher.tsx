'use client';

// Header workspace switcher: the current workspace's name opens a menu of the user's active
// workspaces (each opens on its documents page) and a link back to the workspace home.
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@quiz/ui';
import Link from 'next/link';
import { workspaceHref } from './labels';
import styles from './workspaces.module.css';

export interface WorkspaceSwitcherProps {
  current: { id: string; name: string; status: 'active' | 'archived' };
  workspaces: readonly { id: string; name: string }[];
}

export function WorkspaceSwitcher({ current, workspaces }: WorkspaceSwitcherProps) {
  return (
    <div className={styles.switcher}>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className={styles.switcherTrigger}>
            <span className="qz-visually-hidden">Workspace 전환, 현재: </span>
            <span className={styles.switcherName}>{current.name}</span>
            <span aria-hidden="true">▾</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" aria-label="Workspace 전환">
          {workspaces.map((workspace) => (
            <DropdownMenuItem key={workspace.id} asChild>
              <Link
                href={workspaceHref(workspace.id)}
                aria-current={workspace.id === current.id ? 'true' : undefined}
              >
                {workspace.name}
              </Link>
            </DropdownMenuItem>
          ))}
          {workspaces.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem asChild>
            <Link href="/workspaces">모든 Workspace 보기</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {current.status === 'archived' ? <Badge tone="warning">보관됨</Badge> : null}
    </div>
  );
}
