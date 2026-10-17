// Frame for every protected route (`/workspaces/**`, `/settings/**`). The proxy already redirects
// signed-out requests; this re-checks with `getClaims()` (defence in depth) and renders the
// @quiz/ui AppShell. Workspace routes add the switcher and the workspace navigation.
import { ToastProvider } from '@quiz/ui';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { LOGIN_PATH } from '@/lib/auth/routes';
import { getVerifiedUser } from '@/lib/supabase/server';
import styles from './authenticated-shell.module.css';
import { AppFrame } from './app-frame';
import { UserMenu } from './user-menu';

export interface AuthenticatedShellProps {
  children: ReactNode;
  /** Header content after the brand (e.g. the workspace switcher). */
  headerContent?: ReactNode;
  /** Left navigation (desktop sidebar, mobile drawer). */
  sidebar?: ReactNode;
  navLabel?: string;
}

export async function AuthenticatedShell({
  children,
  headerContent,
  sidebar,
  navLabel,
}: AuthenticatedShellProps) {
  const user = await getVerifiedUser();
  if (!user) redirect(LOGIN_PATH);

  return (
    <ToastProvider>
      <AppFrame
        sidebar={sidebar}
        navLabel={navLabel}
        header={
          <div className={styles.header}>
            <Link href="/workspaces" className={styles.brand}>
              Quiz Workspace
            </Link>
            {headerContent}
            <UserMenu email={user.email} />
          </div>
        }
      >
        {children}
      </AppFrame>
    </ToastProvider>
  );
}
