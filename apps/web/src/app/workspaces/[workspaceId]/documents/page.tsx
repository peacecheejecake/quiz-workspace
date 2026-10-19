// Pre-UX3c DOC-01 route: documents are the workspace home's "문서 관리" dialog now.
import { redirect } from 'next/navigation';
import { legacyPanelRedirect } from '@/lib/workspaces/home';

export default async function Page({
  params,
}: Readonly<{ params: Promise<{ workspaceId: string }> }>) {
  const { workspaceId } = await params;
  redirect(legacyPanelRedirect(workspaceId, 'documents'));
}
