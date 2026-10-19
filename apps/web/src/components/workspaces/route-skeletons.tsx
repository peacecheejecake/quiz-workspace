// QOV-01-AC09 (UX3c): route-level skeletons (`loading.tsx`) so a click changes the screen at once
// and the data streams in. Decorative blocks inside an `aria-busy` region with a text status.
import { Skeleton } from '@quiz/ui';
import type { ReactNode } from 'react';
import styles from './route-skeletons.module.css';

function Busy({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div aria-busy="true" className={styles.skeleton}>
      <p role="status" className="qz-visually-hidden">
        {label}
      </p>
      {children}
    </div>
  );
}

/** The workspace home: header (search + actions), toolbar and heatmap blocks. */
export function HomeSkeleton() {
  return (
    <Busy label="Workspace를 불러오는 중입니다.">
      <div className={styles.row}>
        <Skeleton shape="rect" width="min(36rem, 100%)" height="2.25rem" />
        <div className={styles.actions}>
          <Skeleton shape="rect" width="5rem" height="2.25rem" />
          <Skeleton shape="rect" width="5rem" height="2.25rem" />
          <Skeleton shape="rect" width="2.25rem" height="2.25rem" />
        </div>
      </div>
      <Skeleton shape="rect" width="12rem" height="1.75rem" />
      <Skeleton shape="rect" height="8rem" />
      <Skeleton shape="rect" height="8rem" />
    </Busy>
  );
}

/** A sub-page: back link, breadcrumb, title and a few content blocks. */
export function SubPageSkeleton({ label }: { readonly label: string }) {
  return (
    <Busy label={label}>
      <Skeleton width="16rem" />
      <Skeleton shape="rect" width="14rem" height="2rem" />
      <Skeleton shape="rect" height="4.5rem" />
      <Skeleton shape="rect" height="4.5rem" />
      <Skeleton shape="rect" height="4.5rem" />
    </Busy>
  );
}
