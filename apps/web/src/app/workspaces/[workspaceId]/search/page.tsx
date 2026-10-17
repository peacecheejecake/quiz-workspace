// SEARCH-01 다국어 원문 검색 (docs/screens/search.md). Workspace access (404 for unknown and
// foreign workspaces) is checked by the workspace layout and again here; the document filter list
// is read server-side, the search itself runs in the client (SearchScreen) through the BFF.
import type { Metadata } from 'next';
import { unstable_rethrow } from 'next/navigation';
import { SearchScreen, type SearchDocumentOption } from '@/components/search/search-screen';
import { loadDocuments } from '@/lib/documents/data';
import { parseSearchParams } from '@/lib/search/state';
import { requireWorkspace } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: '원문 검색' };

export default async function Page({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const workspace = await requireWorkspace(workspaceId);
  let documents: SearchDocumentOption[] = [];
  let loadFailed = false;
  try {
    documents = (await loadDocuments(workspace.id))
      .filter((d) => d.active_revision_id !== null)
      .map((d) => ({
        id: d.id,
        title: d.title,
        isQuestionPaper: d.document_type === 'question_paper',
      }));
  } catch (error) {
    unstable_rethrow(error);
    loadFailed = true;
  }

  return (
    <div data-screen-id="SEARCH-01">
      <SearchScreen
        key={workspace.id}
        workspaceId={workspace.id}
        documents={documents}
        documentsLoadFailed={loadFailed}
        initial={parseSearchParams(query)}
      />
    </div>
  );
}
