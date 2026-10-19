// QOV-01 Workspace 홈 (docs/screens/questions-overview.md "Workspace 홈 레이아웃", UX3c): the single
// page of a workspace. The workspace layout already resolved access (404 for unknown, foreign and
// deleted workspaces). Server-side, through the Bearer helper: the caller's heatmap under the URL
// filters (the search text `q` filters it only when the unified search's scope includes 문제),
// the documents (header count, 문서 관리 / 문제 PDF 관리 dialogs, content-search filter) and the
// verified user. Everything else — dialogs (`?panel=`), the content search (`q`, `scope`, options)
// and the practice panel (`?question=`, QPLAY-01) — is client state on top of it.
import type { Metadata } from 'next';
import { unstable_rethrow } from 'next/navigation';
import { WorkspaceHome } from '@/components/workspaces/workspace-home';
import { loadDocuments, type DocumentSummary } from '@/lib/documents/data';
import { loadOverview } from '@/lib/questions/overview-data';
import { openQuestionId, parseOverviewFilters } from '@/lib/questions/overview-filters';
import { parseSearchParams } from '@/lib/search/state';
import { getVerifiedUser } from '@/lib/supabase/server';
import { requireWorkspace } from '@/lib/workspaces/data';
import { parseScope, scopeIncludesQuestions } from '@/lib/workspaces/home';

export const metadata: Metadata = { title: 'Workspace 홈' };

async function documentsOrFailure(workspaceId: string) {
  try {
    return { documents: await loadDocuments(workspaceId), failed: false };
  } catch (error) {
    unstable_rethrow(error);
    return { documents: [] as DocumentSummary[], failed: true };
  }
}

export default async function Page({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const parsed = parseOverviewFilters(query);
  const filters = scopeIncludesQuestions(parseScope(query)) ? parsed : { ...parsed, q: '' };
  const [workspace, data, docs, user] = await Promise.all([
    requireWorkspace(workspaceId),
    loadOverview(workspaceId, filters, openQuestionId(query)),
    documentsOrFailure(workspaceId),
    getVerifiedUser(),
  ]);

  return (
    <div data-screen-id="QOV-01">
      <WorkspaceHome
        key={workspace.id}
        workspace={{
          id: workspace.id,
          name: workspace.name,
          role: workspace.role,
          archived: workspace.status === 'archived',
        }}
        viewerId={user?.id ?? null}
        filters={filters}
        overview={data.overview}
        chapterChoices={data.chapterChoices}
        failure={data.failure}
        requested={data.requested}
        documents={docs.documents}
        documentsLoadFailed={docs.failed}
        initialSearch={parseSearchParams(query)}
        screenIds={{
          documents: 'DOC-01',
          search: 'SEARCH-01',
          practice: 'QPLAY-01',
          history: 'HISTORY-01',
          share: 'WS-SHARE-01',
        }}
      />
    </div>
  );
}
