// SEARCH-02 본문 검색 페이지 (docs/screens/search-page.md, UX9): the 본문 search, reached from the
// workspace home header's `본문 검색` link. The workspace layout already resolved access (404 for
// unknown, foreign and deleted workspaces). Server-side: the published books for the document
// filter and for whether there is anything to search (question papers never are, UX7-SEARCH-2);
// the search itself runs client-side through the same-origin relay. The pre-UX3c URL of this
// route (`?q=&chapter=`) is rewritten to this page's keys (`text`, `section`) first.
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ContentSearchPage } from '@/components/search/content-search-page';
import { loadDocumentsOrFailure } from '@/lib/documents/data';
import { hasSearchableBody, isSearchableBody } from '@/lib/search/scope';
import { requireWorkspace } from '@/lib/workspaces/data';
import { isLegacySearchUrl, legacySearchRedirect } from '@/lib/workspaces/home';

export const metadata: Metadata = { title: '본문 검색' };

export default async function Page({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  if (isLegacySearchUrl(query)) redirect(legacySearchRedirect(workspaceId, query));
  const [workspace, docs] = await Promise.all([
    requireWorkspace(workspaceId),
    loadDocumentsOrFailure(workspaceId),
  ]);

  return (
    <div data-screen-id="SEARCH-02">
      <ContentSearchPage
        key={workspace.id}
        workspace={{ id: workspace.id, name: workspace.name }}
        documents={docs.documents
          .filter(isSearchableBody)
          .map((d) => ({ id: d.id, title: d.title }))}
        documentsLoadFailed={docs.failed}
        searchable={hasSearchableBody(docs.documents, docs.failed)}
      />
    </div>
  );
}
