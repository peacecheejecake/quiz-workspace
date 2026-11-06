import type { ReactNode } from 'react';
import { AuthenticatedShell } from '@/components/app-shell/authenticated-shell';

export default function HelpLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <AuthenticatedShell>{children}</AuthenticatedShell>;
}
