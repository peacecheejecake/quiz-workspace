// Minimal centered frame for the signed-out auth screens (A2.1). A2.2 replaces it with the
// design-system `AuthLayout`; `data-screen-id` on <main> is the stub/harness contract.
import { Surface } from '@quiz/ui';
import type { ReactNode } from 'react';
import type { ScreenId } from '@/screens';
import styles from './auth-card.module.css';

export interface AuthCardProps {
  screenId: ScreenId;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}

export function AuthCard({ screenId, title, description, children, footer }: AuthCardProps) {
  return (
    <main className={styles.main} data-screen-id={screenId}>
      <Surface padding="lg" className={styles.card}>
        <h1 className={styles.title}>{title}</h1>
        {description ? <p className={styles.description}>{description}</p> : null}
        {children}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </Surface>
    </main>
  );
}
