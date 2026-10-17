// QOV-01 Questions Heatmap 홈 (docs/screens/questions-overview.md). The workspace layout already
// resolved access (404 for unknown/foreign workspaces); this page reads the caller's heatmap under
// the URL filters through the server-side Bearer helper. `?question=` (the practice panel,
// QPLAY-01) is client state on top of it.
import type { Metadata } from 'next';
import { QuestionsOverview } from '@/components/questions/overview/questions-overview';
import { loadOverview } from '@/lib/questions/overview-data';
import { openQuestionId, parseOverviewFilters } from '@/lib/questions/overview-filters';
import { requireWorkspace } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: '문제 Heatmap' };

export default async function Page({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const filters = parseOverviewFilters(query);
  const [workspace, data] = await Promise.all([
    requireWorkspace(workspaceId),
    loadOverview(workspaceId, filters, openQuestionId(query)),
  ]);
  const readOnly =
    workspace.status === 'archived' ? 'archived' : workspace.role === 'viewer' ? 'viewer' : null;

  return (
    <div data-screen-id="QOV-01">
      <QuestionsOverview
        workspaceId={workspace.id}
        readOnly={readOnly}
        filters={filters}
        overview={data.overview}
        chapterChoices={data.chapterChoices}
        failure={data.failure}
        requested={data.requested}
        panelScreenId="QPLAY-01"
      />
    </div>
  );
}
