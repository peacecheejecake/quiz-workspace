'use client';

// AppShell whose mobile navigation drawer closes on every route change: a link inside the drawer,
// and also browser Back/Forward (the drawer must not reopen on returning to an earlier page).
import { AppShell, type AppShellProps } from '@quiz/ui';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

export interface DrawerState {
  readonly open: boolean;
  readonly pathname: string;
}

/** Drawer state for the current pathname: any pathname change resets it to closed. */
export function drawerFor(state: DrawerState, pathname: string): DrawerState {
  return state.pathname === pathname ? state : { open: false, pathname };
}

export function AppFrame(props: Omit<AppShellProps, 'mobileNavOpen' | 'onMobileNavOpenChange'>) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState<DrawerState>({ open: false, pathname });
  const current = drawerFor(drawer, pathname);
  // Store the reset (React's "adjust state on prop change" pattern) so returning to the old
  // pathname later does not resurrect `open: true`.
  if (current !== drawer) setDrawer(current);
  return (
    <AppShell
      {...props}
      mobileNavOpen={current.open}
      onMobileNavOpenChange={(open) => setDrawer({ open, pathname })}
    />
  );
}
