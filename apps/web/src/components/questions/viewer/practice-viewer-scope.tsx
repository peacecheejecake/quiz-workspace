'use client';

import { useLayoutEffect, useState, type ReactNode } from 'react';
import {
  currentVerifiedUserId,
  hasVerifiedUser,
  VERIFIED_USER_EVENT,
  VERIFIED_USER_PENDING_EVENT,
  verifiedUserPending,
} from '@/lib/auth/verified-user-events';
import { setPracticeViewer } from '@/lib/questions/practice-reset-events';

export function PracticeViewerScope({
  viewerId,
  children,
}: {
  viewerId: string | null;
  children: ReactNode;
}) {
  const [ready, setReady] = useState<string | null>(null);
  const [suspended, setSuspended] = useState(false);
  useLayoutEffect(() => {
    const matches = !hasVerifiedUser() || currentVerifiedUserId() === viewerId;
    setPracticeViewer(matches ? viewerId : null);
    // Keep private children unmounted until their verified identity owns the shared scope.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(matches ? viewerId : null);
    const pending = () => setSuspended(true);
    const verified = (event: Event) => {
      const id = (event as CustomEvent<string | null>).detail;
      setSuspended(verifiedUserPending());
      if (id !== viewerId) {
        setPracticeViewer(null);
        setReady(null);
      } else {
        setPracticeViewer(viewerId);
        setReady(viewerId);
      }
    };
    window.addEventListener(VERIFIED_USER_PENDING_EVENT, pending);
    window.addEventListener(VERIFIED_USER_EVENT, verified);
    setSuspended(verifiedUserPending());
    return () => {
      window.removeEventListener(VERIFIED_USER_PENDING_EVENT, pending);
      window.removeEventListener(VERIFIED_USER_EVENT, verified);
    };
  }, [viewerId]);
  return ready && ready === viewerId ? (
    <div hidden={suspended} inert={suspended}>
      {children}
    </div>
  ) : null;
}
