'use client';

// AppShell with its mobile navigation drawer closed after every client-side navigation (a link
// inside the drawer changes the route but would otherwise leave the drawer open).
import { AppShell, type AppShellProps } from '@quiz/ui';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

export function AppFrame(props: Omit<AppShellProps, 'mobileNavOpen' | 'onMobileNavOpenChange'>) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState<{ open: boolean; pathname: string }>({
    open: false,
    pathname,
  });
  // Derived during render instead of an effect: a new pathname means the drawer is closed.
  const open = drawer.open && drawer.pathname === pathname;
  return (
    <AppShell
      {...props}
      mobileNavOpen={open}
      onMobileNavOpenChange={(next) => setDrawer({ open: next, pathname })}
    />
  );
}
