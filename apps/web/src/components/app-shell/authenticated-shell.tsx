// Frame for every protected route (`/workspaces/**`, `/settings/**`). The proxy already redirects
// signed-out requests; this re-checks with `getClaims()` (defence in depth) and renders the
// @quiz/ui AppShell. Workspace navigation (sidebar, switcher) arrives with M3.
import { AppShell } from '@quiz/ui';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { LOGIN_PATH } from '@/lib/auth/routes';
import { getVerifiedUser } from '@/lib/supabase/server';
import styles from './authenticated-shell.module.css';
import { UserMenu } from './user-menu';

export async function AuthenticatedShell({ children }: { children: ReactNode }) {
  const user = await getVerifiedUser();
  if (!user) redirect(LOGIN_PATH);

  return (
    <AppShell
      header={
        <div className={styles.header}>
          <Link href="/workspaces" className={styles.brand}>
            Quiz Workspace
          </Link>
          <UserMenu email={user.email} />
        </div>
      }
    >
      {children}
    </AppShell>
  );
}
