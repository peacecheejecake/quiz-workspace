'use client';

// SEARCH-02 본문 검색 페이지 `/workspaces/:id/search` (docs/screens/search-page.md, UX9): the 본문
// search that used to be a collapsed area of the workspace home (SEARCH-01-AC10, retired). Its
// rules are SEARCH-01's (content-search.tsx): the box with an icon submit and "본문 설정", Enter or
// the button runs it, results open the modal excerpt panel. Its state is this page's URL
// (`text`, `mode`, `document`, `section`), written in place. The search on arrival comes from the
// address bar, not the server render: Back from the PDF viewer restores this page under the URL
// the search wrote. Without a query in the URL the box takes focus; with one, the results do the
// talking. Beside the search button, `AI에게 묻기` (ASK-01) opens the AI 질문 panel on this page, over
// the search, on a new conversation with the search text in its input (not sent) and the document
// filter as its 질문 범위; the panel is modal like this page's excerpt panel (HOMEDLG-01) and, like
// it, outside the URL — the home's `?panel=ask` is where saved conversations are reopened.
import { BackLink, PageHeader } from '@quiz/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { AskPanel, type AskIntent } from '@/components/ask/ask-panel';
import { AskSearchButton } from '@/components/ask/ask-search-button';
import { useAskState } from '@/components/ask/use-ask-state';
import { WorkspaceBreadcrumb, type WorkspaceCrumb } from '@/components/workspaces/sub-page-nav';
import { unavailableReason, unavailableText } from '@/lib/ask/model';
import { CONTENT_QUERY_PARAM, MAX_QUERY_CHARS, parseSearchParams } from '@/lib/search/state';
import { workspaceHomePath } from '@/lib/workspaces/home';
import {
  ContentSearchOptions,
  ContentSearchResults,
  replaceAddress,
  useContentSearch,
  type SearchDocumentOption,
} from './content-search';
import { ContentSearchForm } from './content-search-form';
import { adoptSearchEntry, enteredFromHome, isPlainClick } from './search-entry';
import styles from './search.module.css';

export interface ContentSearchPageProps {
  readonly workspace: WorkspaceCrumb & { readonly archived: boolean };
  /** The published books of the document filter (question papers are never searched). */
  readonly documents: readonly SearchDocumentOption[];
  readonly documentsLoadFailed: boolean;
  /** False when the workspace has no published book to search. */
  readonly searchable: boolean;
}

export function ContentSearchPage({
  workspace,
  documents,
  documentsLoadFailed,
  searchable,
}: ContentSearchPageProps) {
  const searchParams = useSearchParams();
  const [initial] = useState(() => parseSearchParams(Object.fromEntries(searchParams)));
  const content = useContentSearch({
    workspaceId: workspace.id,
    initial,
    runInitial: searchable,
  });
  const [draft, setDraft] = useState(initial.query);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const initialQueryRef = useRef(initial.query);
  useEffect(() => {
    adoptSearchEntry();
    if (!initialQueryRef.current) inputRef.current?.focus();
  }, []);

  function search() {
    const q = draft.trim().slice(0, MAX_QUERY_CHARS);
    if (q) content.search(q);
    else clear();
  }

  /**
   * "검색 결과 지우기": the query and the results only (search-page.md). The options (mode,
   * document, chapter) stay chosen, in the state and in the URL alike, so a reload keeps them.
   */
  function clear() {
    setDraft('');
    content.clear();
    const url = new URL(window.location.href);
    url.searchParams.delete(CONTENT_QUERY_PARAM);
    replaceAddress(`${url.pathname}${url.search}`);
  }

  // --- AI에게 묻기 (ASK-01) ---------------------------------------------------------------------
  const ask = useAskState(workspace.id);
  const askReason = unavailableReason(ask.state, workspace.archived);
  const askUnavailable = askReason ? unavailableText(askReason) : null;
  const [askOpen, setAskOpen] = useState(false);
  // Each opening starts the panel afresh: unsent input never survives a close.
  const [askSession, setAskSession] = useState(0);
  const [askConversation, setAskConversation] = useState<string | null>(null);
  const [askIntent, setAskIntent] = useState<AskIntent | null>(null);
  function askFromSearch() {
    if (!ask.state?.available || workspace.archived) return;
    setAskIntent({
      key: askSession + 1,
      text: draft.trim(),
      scope: {
        document_ids: content.documentId ? [content.documentId] : [],
        chapter_ids: content.documentId && content.chapterId ? [content.chapterId] : [],
      },
    });
    setAskConversation(null);
    setAskSession((n) => n + 1);
    setAskOpen(true);
  }

  /** Entered from the home: back to the home entry it came from, as the browser's Back does. */
  function back(event: MouseEvent<HTMLAnchorElement>) {
    if (!isPlainClick(event) || !enteredFromHome()) return;
    event.preventDefault();
    window.history.back();
  }

  return (
    <div className={styles.page}>
      <PageHeader
        back={
          <BackLink
            href={workspaceHomePath(workspace.id)}
            label="Workspace 홈"
            linkComponent={Link}
            onClick={back}
          />
        }
        breadcrumb={<WorkspaceBreadcrumb workspace={workspace} trail={[{ label: '본문 검색' }]} />}
        title="본문 검색"
      />
      <ContentSearchForm
        inputRef={inputRef}
        draft={draft}
        onDraftChange={setDraft}
        onSearch={search}
        searchable={searchable}
        extraAction={
          ask.state?.available && !workspace.archived ? (
            <AskSearchButton unavailable={askUnavailable} onAsk={askFromSearch} />
          ) : null
        }
        settings={
          <ContentSearchOptions
            search={content}
            documents={documents}
            documentsLoadFailed={documentsLoadFailed}
          />
        }
      />
      {searchable && !content.submitted ? (
        <p className={styles.hint}>교재 본문에서 찾을 말을 입력하세요.</p>
      ) : null}
      {searchable ? (
        <ContentSearchResults workspaceId={workspace.id} search={content} onClose={clear} />
      ) : null}
      <AskPanel
        key={askSession}
        open={askOpen}
        onOpenChange={setAskOpen}
        container={null}
        workspaceId={workspace.id}
        archived={workspace.archived}
        askState={ask.state}
        client={ask.client}
        conversationId={askConversation}
        onNavigate={(conversationId) => setAskConversation(conversationId)}
        documents={documents}
        intent={askIntent}
        screenId="ASK-01"
        modal
      />
    </div>
  );
}
