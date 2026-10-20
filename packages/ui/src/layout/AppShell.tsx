'use client';

import { Dialog } from 'radix-ui';
import { useState, type ReactNode } from 'react';
import { cx } from '../internal/cx';
import { LayerProvider } from '../internal/layer';
import { IconButton } from '../primitives/IconButton';
import { CloseIcon, MenuIcon } from '../primitives/icons';

export interface AppShellProps {
  /** Top bar content (brand, workspace switcher, search, account menu). */
  header: ReactNode;
  /** Navigation content; rendered as a fixed sidebar on desktop and a drawer on mobile. */
  sidebar?: ReactNode;
  /** Accessible name of the navigation landmark (sidebar and drawer). */
  navLabel?: string;
  /** Accessible name of the mobile menu button. */
  menuLabel?: string;
  closeMenuLabel?: string;
  skipLinkLabel?: string;
  /** `id` of the `<main>` element targeted by the skip link. */
  mainId?: string;
  /** Controlled mobile drawer state (close it after client-side navigation). */
  mobileNavOpen?: boolean;
  onMobileNavOpenChange?: (open: boolean) => void;
  className?: string;
  children?: ReactNode;
}

/**
 * Application frame (docs/design-system.md §4): 64px header, 232px sidebar on desktop, modal
 * drawer navigation on mobile, content capped at 1440px with 24px (desktop) / 16px (mobile)
 * padding, and a skip link to the main content.
 */
export function AppShell({
  header,
  sidebar,
  navLabel = '주 메뉴',
  menuLabel = '메뉴 열기',
  closeMenuLabel = '메뉴 닫기',
  skipLinkLabel = '본문으로 건너뛰기',
  mainId = 'main-content',
  mobileNavOpen,
  onMobileNavOpenChange,
  className,
  children,
}: AppShellProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const drawerOpen = mobileNavOpen ?? uncontrolledOpen;
  const setDrawerOpen = (open: boolean) => {
    if (mobileNavOpen === undefined) setUncontrolledOpen(open);
    onMobileNavOpenChange?.(open);
  };

  return (
    <div className={cx('qz-app-shell', className)} data-has-sidebar={sidebar ? true : undefined}>
      <a href={`#${mainId}`} className="skip-link qz-focus-ring">
        {skipLinkLabel}
      </a>
      <header className="header glass-surface">
        {sidebar ? (
          <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
            <Dialog.Trigger asChild>
              <IconButton label={menuLabel} icon={<MenuIcon />} className="menu-button" />
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="qz-backdrop" data-layer="drawer" />
              <Dialog.Content className="qz-drawer" aria-describedby={undefined}>
                <LayerProvider value="var(--z-modal)">
                  <div className="header">
                    <Dialog.Title className="title">{navLabel}</Dialog.Title>
                    <Dialog.Close asChild>
                      <IconButton label={closeMenuLabel} icon={<CloseIcon />} />
                    </Dialog.Close>
                  </div>
                  <nav aria-label={navLabel} className="nav">
                    {sidebar}
                  </nav>
                </LayerProvider>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        ) : null}
        <div className="content">{header}</div>
      </header>
      <div className="body">
        {sidebar ? (
          <nav aria-label={navLabel} className="sidebar">
            {sidebar}
          </nav>
        ) : null}
        <main id={mainId} tabIndex={-1} className="main">
          <div className="content">{children}</div>
        </main>
      </div>
    </div>
  );
}
