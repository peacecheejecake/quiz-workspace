// Pre-UX3c HISTORY-01 route: history is the workspace home's "이력" dialog now.
import { redirect } from 'next/navigation';
import { legacyPanelRedirect } from '@/lib/workspaces/home';

export default async function Page({
  params,
}: Readonly<{ params: Promise<{ workspaceId: string }> }>) {
  const { workspaceId } = await params;
  redirect(legacyPanelRedirect(workspaceId, 'history'));
}
