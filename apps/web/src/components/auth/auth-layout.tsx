// `AuthLayout` (docs/design-system.md §7) for every signed-out auth screen (AUTH-01…07): brand
// header, one centred opaque card with the page title and an optional footer of secondary links.
// `<main data-screen-id>` is the harness contract; form alerts live inside <main> (auth-ui.ts).
//
// Kept in apps/web rather than @quiz/ui: the auth screens are bound to this app's routes, server
// actions and Supabase clients, and no other consumer exists. Only the generic primitives (Surface,
// Input, Button) come from @quiz/ui.
import { Surface } from '@quiz/ui';
import type { ReactNode } from 'react';
import type { ScreenId } from '@/screens';
import styles from './auth-layout.module.css';

export interface AuthLayoutProps {
  screenId: ScreenId;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Secondary navigation (sign-in / sign-up / recovery links). */
  footer?: ReactNode;
}

export function AuthLayout({ screenId, title, description, children, footer }: AuthLayoutProps) {
  return (
    <div className={styles.page}>
      <header className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true" />
        <span>Quiz Workspace</span>
      </header>
      <main className={styles.main} data-screen-id={screenId}>
        <Surface padding="lg" className={styles.card}>
          <div className={styles.heading}>
            <h1 className={styles.title}>{title}</h1>
            {description ? <p className={styles.description}>{description}</p> : null}
          </div>
          {children}
          {footer ? (
            <nav aria-label="인증 메뉴" className={styles.footer}>
              {footer}
            </nav>
          ) : null}
        </Surface>
      </main>
    </div>
  );
}
