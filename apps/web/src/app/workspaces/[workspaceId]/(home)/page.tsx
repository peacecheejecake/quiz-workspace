// QOV-01 Workspace 홈 (docs/screens/questions-overview.md "Workspace 홈 레이아웃", UX3c): the single
// page of a workspace. The workspace layout already resolved access (404 for unknown, foreign and
// deleted workspaces). Server-side, through the Bearer helper: the caller's heatmap under the URL
// filters (`q` is the 문제 search, SEARCH-01-AC12),
// the documents (header count, 문서 관리 dialog) and the verified user. Everything else —
// dialogs (`?panel=`, the 정리 노트 panel CHNOTE-01 with its `chapter`, the 문서 요약 panel
// DOCSUM-01 with its `document`) and the practice panel (`?question=`, QPLAY-01) — is client
// state on top of it. A UX6 unified-search URL (`scope=`) and a retired panel value are
// redirected first, and a 본문 search (`text`) goes to its own page since UX9 (homeRedirect,
// SEARCH-02).
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { WorkspaceHome } from '@/components/workspaces/workspace-home';
import { loadDocumentsOrFailure } from '@/lib/documents/data';
import { loadOverview } from '@/lib/questions/overview-data';
import { openQuestionId, parseOverviewFilters } from '@/lib/questions/overview-filters';
import { getVerifiedUser } from '@/lib/supabase/server';
import { requireWorkspace } from '@/lib/workspaces/data';
import { isChapterNoteOpen, homeRedirect } from '@/lib/workspaces/home';

export const metadata: Metadata = { title: 'Workspace 홈' };

export default async function Page({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  // Retired URL state in one redirect: a UX6 unified-search `scope=` (UX7-SEARCH),
  // `?panel=question-pdfs`, the retired 문제 PDF 관리 that opens 문서 관리 now (UX7-DOCS), and the
  // home's 본문 search `text=`, now the search page's (SEARCH-02-AC03).
  const migrated = homeRedirect(workspaceId, query);
  if (migrated !== null) redirect(migrated);
  // While the 정리 노트 panel is open, `chapter` is its chapter, not a heatmap filter (home.ts).
  const urlFilters = parseOverviewFilters(query);
  const filters = isChapterNoteOpen(query) ? { ...urlFilters, chapter: null } : urlFilters;
  const [workspace, data, docs, user] = await Promise.all([
    requireWorkspace(workspaceId),
    loadOverview(workspaceId, filters, openQuestionId(query)),
    loadDocumentsOrFailure(workspaceId),
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
        unfilteredOverview={data.unfilteredOverview}
        querylessOverview={data.querylessOverview}
        chapterChoices={data.chapterChoices}
        failure={data.failure}
        requested={data.requested}
        hasQuestions={data.hasQuestions}
        documents={docs.documents}
        documentsLoadFailed={docs.failed}
        summaryAvailable={docs.summaryAvailable}
        screenIds={{
          documents: 'DOC-01',
          search: 'SEARCH-01',
          practice: 'QPLAY-01',
          history: 'HISTORY-01',
          share: 'WS-SHARE-01',
          chapterNote: 'CHNOTE-01',
          summary: 'DOCSUM-01',
          mockExams: 'MOCK-01',
          redistribution: 'CHREDIST-01',
        }}
      />
    </div>
  );
}
