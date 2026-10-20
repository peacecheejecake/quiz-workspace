// Pre-UX3c WS-SHARE-01 route: sharing is the workspace home's "링크 공유" dialog now (owner only;
// the home ignores `?panel=share` for other members and FastAPI refuses them).
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { legacyPanelRedirect } from '@/lib/workspaces/home';

export const metadata: Metadata = { referrer: 'no-referrer' };

export default async function Page({
  params,
}: Readonly<{ params: Promise<{ workspaceId: string }> }>) {
  const { workspaceId } = await params;
  redirect(legacyPanelRedirect(workspaceId, 'share'));
}
