'use client';

// Workspace left navigation (AppShell sidebar / mobile drawer). The current section carries
// aria-current="page"; "공유 설정" is listed for owners only (the API enforces it regardless).
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './workspaces.module.css';

interface NavEntry {
  readonly segment: string;
  readonly label: string;
  readonly ownerOnly?: boolean;
}

export const WORKSPACE_NAV: readonly NavEntry[] = [
  { segment: 'documents', label: '문서' },
  { segment: 'search', label: '검색' },
  { segment: 'questions', label: '문제' },
  { segment: 'history', label: '이력' },
  { segment: 'settings/sharing', label: '공유 설정', ownerOnly: true },
];

export function WorkspaceNav({ workspaceId, isOwner }: { workspaceId: string; isOwner: boolean }) {
  const pathname = usePathname();
  const base = `/workspaces/${workspaceId}`;
  return (
    <ul className={styles.nav}>
      {WORKSPACE_NAV.filter((entry) => isOwner || !entry.ownerOnly).map((entry) => {
        const href = `${base}/${entry.segment}`;
        const current = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <li key={entry.segment}>
            <Link
              href={href}
              aria-current={current ? 'page' : undefined}
              className={`${styles.navLink} qz-focus-ring`}
            >
              {entry.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
