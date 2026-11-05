'use client';

import { useLayoutEffect, useState, type ReactNode } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { setPracticeViewer } from '@/lib/questions/practice-reset-events';

export function PracticeViewerScope({
  viewerId,
  children,
}: {
  viewerId: string | null;
  children: ReactNode;
}) {
  const [ready, setReady] = useState<string | null>(null);
  useLayoutEffect(() => {
    setPracticeViewer(viewerId);
    // Keep private children unmounted until their verified identity owns the shared scope.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(viewerId);
    const { data } = getSupabaseBrowserClient().auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (event === 'SIGNED_IN' && session?.user.id !== viewerId)) {
        setPracticeViewer(null);
        setReady(null);
      }
    });
    return () => data.subscription.unsubscribe();
  }, [viewerId]);
  return ready && ready === viewerId ? children : null;
}
