'use client';

// UX12-NAV-AC01: an in-app link that marks itself while its navigation has no answer yet. The kit
// cannot import Next, so this is the `linkComponent` the web app hands to Breadcrumb and BackLink.
// `useLinkStatus` only works under a `Link`, hence the child.
import Link, { useLinkStatus } from 'next/link';
import type { ComponentProps } from 'react';
import styles from './pending-link.module.css';

function PendingMark() {
  const { pending } = useLinkStatus();
  return pending ? (
    <span aria-hidden="true" data-link-pending="true" className={styles.mark} />
  ) : null;
}

export function PendingLink({ className, children, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link className={[styles.link, className].filter(Boolean).join(' ')} {...props}>
      {children}
      <PendingMark />
    </Link>
  );
}
