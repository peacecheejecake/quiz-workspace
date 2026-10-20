'use client';

// Workspace home `/workspaces/:id` (QOV-01, docs/screens/questions-overview.md "Workspace 홈
// 레이아웃", UX3c): the single page of a workspace, without a sidebar.
//
//   Workspace header  unified search (SEARCH-01-AC07: one box, icon submit, "검색 옵션" popover
//                     with the scope checkboxes, the content-search options and the heatmap's
//                     chapter/type filters) · `문서 n` · `문제은행` · `이력` · `공유하기` (owner)
//   content results   the 원문 search results when the scope includes 내용
//   문제 영역         the heatmap (QuestionsOverview) with `문제 PDF 관리` / `문제 생성`
//   floating dialogs  문서 관리 · 문제 PDF 관리 · 문제 생성 · 이력 · 링크 공유: non-modal
//                     FloatingSidePanels portalled into this page (inside <main>), opened at once
//                     and listed in the URL (`?panel=`, repeatable); the most recently opened is
//                     on top (UX3b stacking).
//
// State lives in the URL: heatmap filters (overview-filters.ts), `q`/`scope` and the content
// options (search/state.ts), `panel`, and `question` (the practice panel). Dialog and panel
// changes use history.pushState (Next syncs useSearchParams; no server round trip); filter and
// search changes that alter the heatmap use router.replace (the server re-reads the overview).
import {
  Button,
  Checkbox,
  ConfirmDialog,
  FloatingSidePanel,
  HistoryIcon,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  questionTypeLabels,
  SearchIcon,
  Select,
  type QuestionType,
} from '@quiz/ui';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, useTransition, type FormEvent } from 'react';
import { DocumentsLibrary } from '@/components/documents/documents-library';
import { useDocumentLibrary } from '@/components/documents/use-document-library';
import { HistoryPanel } from '@/components/history/history-panel';
import { GenerationDialog } from '@/components/questions/generate/generation-dialog';
import { QuestionPdfsLibrary } from '@/components/questions/import/question-pdfs';
import { QuestionsOverview } from '@/components/questions/overview/questions-overview';
import {
  ContentSearchOptions,
  ContentSearchResults,
  useContentSearch,
} from '@/components/search/content-search';
import { WorkspaceSharingPanel } from '@/components/sharing/workspace-sharing-panel';
import type { DocumentSummary } from '@/lib/documents/client-api';
import type { ChapterChoice, QuestionOverview } from '@/lib/questions/overview-data';
import {
  EMPTY_OVERVIEW_FILTERS,
  mergeOverviewFilters,
  OVERVIEW_SEARCH_MAX,
  overviewSearch,
  type OverviewFilters,
} from '@/lib/questions/overview-filters';
import type { PlacedQuestion } from '@/lib/questions/overview-placement';
import type { QuestionFailureKind } from '@/lib/questions/problems';
import type { SearchQuery } from '@/lib/search/client';
import { MAX_QUERY_CHARS, parseSearchParams, searchParamsFor } from '@/lib/search/state';
import {
  parsePanels,
  parseScope,
  patchSearch,
  scopeIncludesContent,
  scopeIncludesQuestions,
  scopeOf,
  withPanel,
  type HomePanel,
  type SearchScope,
} from '@/lib/workspaces/home';
import styles from './workspace-home.module.css';

const ALL = '__all__';
const TYPES: readonly QuestionType[] = ['MCQ', 'SHORT_ANSWER', 'ESSAY'];

export interface WorkspaceHomeProps {
  readonly workspace: {
    readonly id: string;
    readonly name: string;
    readonly role: 'owner' | 'editor' | 'viewer';
    readonly archived: boolean;
  };
  /** Verified id of the signed-in user (history entries of this actor read "나"). */
  readonly viewerId: string | null;
  /** Heatmap filters the server rendered `overview` with (`q` only when the scope has 문제). */
  readonly filters: OverviewFilters;
  readonly overview: QuestionOverview;
  readonly chapterChoices: readonly ChapterChoice[];
  readonly failure: QuestionFailureKind | null;
  readonly requested: PlacedQuestion | null;
  readonly documents: readonly DocumentSummary[];
  readonly documentsLoadFailed: boolean;
  /** The content search in the URL on arrival. */
  readonly initialSearch: SearchQuery;
  /** Screen ids of the parts of this page (`data-screen-id`, docs/screens/index.md). */
  readonly screenIds: {
    readonly documents: string;
    readonly search: string;
    readonly practice: string;
    readonly history: string;
    readonly share: string;
  };
}

export function WorkspaceHome({
  workspace,
  viewerId,
  filters,
  overview,
  chapterChoices,
  failure,
  requested,
  documents,
  documentsLoadFailed,
  initialSearch,
  screenIds,
}: WorkspaceHomeProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [navigating, startNavigation] = useTransition();
  const isOwner = workspace.role === 'owner';
  const canEdit = !workspace.archived && workspace.role !== 'viewer';
  const readOnly = workspace.archived ? 'archived' : workspace.role === 'viewer' ? 'viewer' : null;

  // --- dialogs ------------------------------------------------------------------------------
  const allowed = (panel: HomePanel) =>
    (panel !== 'share' || isOwner) && (panel !== 'generate' || canEdit);
  const panels = parsePanels(searchParams).filter(allowed);
  const isOpen = (panel: HomePanel) => panels.includes(panel);
  // Pressing the button of a dialog that is already open (maybe under another one) raises it.
  const [raised, setRaised] = useState<Partial<Record<HomePanel, number>>>({});
  const setPanel = (panel: HomePanel, open: boolean) => {
    if (open && isOpen(panel)) {
      setRaised((r) => ({ ...r, [panel]: (r[panel] ?? 0) + 1 }));
    }
    window.history.pushState(
      null,
      '',
      `${pathname}${withPanel(window.location.search, panel, open)}`,
    );
  };
  const [host, setHost] = useState<HTMLDivElement | null>(null);

  // --- documents (문서 관리 + 문제 PDF 관리) ----------------------------------------------------
  const library = useDocumentLibrary({
    workspaceId: workspace.id,
    initialDocuments: documents,
    canEdit,
    loadFailed: documentsLoadFailed,
  });
  const bookCount = library.documents.filter((d) => d.document_type === 'book').length;
  const searchDocuments = library.documents
    .filter((d) => d.active_revision_id !== null)
    .map((d) => ({
      id: d.id,
      title: d.title,
      isQuestionPaper: d.document_type === 'question_paper',
    }));

  // --- heatmap filters ----------------------------------------------------------------------
  // Filters as last chosen: quick successive changes build on each other before the URL (and the
  // server render) catch up; a new server render with other filters resets them.
  const filtersKey = overviewSearch(filters);
  const [renderedKey, setRenderedKey] = useState(filtersKey);
  const [view, setView] = useState(filters);
  if (renderedKey !== filtersKey) {
    setRenderedKey(filtersKey);
    setView(filters);
  }

  function changeFilters(patch: Partial<OverviewFilters>) {
    const next = { ...view, ...patch };
    setView(next);
    startNavigation(() => {
      router.replace(`${pathname}${mergeOverviewFilters(window.location.search, next)}`, {
        scroll: false,
      });
    });
  }

  // --- unified search -----------------------------------------------------------------------
  const scope = parseScope(searchParams);
  const [draft, setDraft] = useState(searchParams.get('q') ?? '');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const content = useContentSearch({
    workspaceId: workspace.id,
    initial: initialSearch,
    runInitial: scopeIncludesContent(scope),
  });

  // The address bar can change under us (browser Back/Forward restores an earlier search): the
  // search box, the content options and the executed content search follow it. Our own updates
  // write the same state they already show, so following them is a no-op.
  const urlQ = searchParams.get('q') ?? '';
  const [seenQ, setSeenQ] = useState(urlQ);
  if (seenQ !== urlQ) {
    setSeenQ(urlQ);
    setDraft(urlQ);
  }
  const contentKey =
    urlQ && scopeIncludesContent(scope)
      ? searchParamsFor(parseSearchParams(Object.fromEntries(searchParams)))
      : '';
  const syncedContentKey = useRef(contentKey);
  const syncContent = content.sync;
  useEffect(() => {
    if (syncedContentKey.current === contentKey) return;
    syncedContentKey.current = contentKey;
    const q = contentKey
      ? parseSearchParams(Object.fromEntries(new URLSearchParams(contentKey)))
      : null;
    void Promise.resolve().then(() => syncContent(q));
  }, [contentKey, syncContent]);

  /** Runs `query` under `nextScope`: content results, heatmap filter and the URL. */
  function applySearch(query: string, nextScope: SearchScope) {
    const q = query.trim().slice(0, MAX_QUERY_CHARS);
    if (q && scopeIncludesContent(nextScope)) content.search(q);
    else content.clear();
    const target = `${pathname}${patchSearch(window.location.search, {
      q: q || null,
      scope: nextScope === 'all' ? null : nextScope,
    })}`;
    const heatmapQ = scopeIncludesQuestions(nextScope) ? q.slice(0, OVERVIEW_SEARCH_MAX) : '';
    if (heatmapQ !== filters.q) {
      setView((v) => ({ ...v, q: heatmapQ }));
      startNavigation(() => router.replace(target, { scroll: false }));
    } else {
      window.history.replaceState(null, '', target);
    }
  }

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    applySearch(draft, scope);
  }

  function changeScope(questions: boolean, includeContent: boolean) {
    // The last checked box cannot be turned off (at least one target).
    if (!questions && !includeContent) return;
    applySearch(
      content.submitted?.query ?? searchParams.get('q') ?? '',
      scopeOf(questions, includeContent),
    );
  }

  function resetAll() {
    setDraft('');
    setView(EMPTY_OVERVIEW_FILTERS);
    content.clear();
    startNavigation(() => {
      router.replace(
        `${pathname}${patchSearch(mergeOverviewFilters(window.location.search, EMPTY_OVERVIEW_FILTERS), { q: null })}`,
        { scroll: false },
      );
    });
  }

  function closeContentResults() {
    setDraft('');
    applySearch('', scope);
  }

  const withQuestions = scopeIncludesQuestions(scope);
  const withContent = scopeIncludesContent(scope);
  const chapterOptions = [
    { value: ALL, label: '전체 챕터' },
    ...chapterChoices.map((c) => ({ value: c.value, label: c.title })),
  ];

  return (
    <div className={styles.home} data-panel-open={panels.length > 0 || undefined}>
      <h1 className="qz-visually-hidden">{workspace.name}</h1>

      <div className={styles.header}>
        <form
          role="search"
          aria-label="통합 검색"
          className={styles.search}
          onSubmit={onSearch}
          data-screen-id={screenIds.search}
        >
          <Popover open={optionsOpen} onOpenChange={setOptionsOpen}>
            <div className={styles.searchRow}>
              <Input
                type="search"
                label="검색어"
                hideLabel
                placeholder="문제와 원문 검색"
                value={draft}
                maxLength={MAX_QUERY_CHARS}
                autoComplete="off"
                fieldClassName={styles.searchField}
                onChange={(event) => setDraft(event.target.value)}
              />
              <IconButton type="submit" variant="primary" label="검색" icon={<SearchIcon />} />
            </div>
            <PopoverTrigger asChild>
              <button type="button" className={`${styles.optionsToggle} qz-focus-ring`}>
                검색 옵션
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              aria-label="검색 옵션"
              closeLabel="검색 옵션 닫기"
              className={styles.options}
            >
              <fieldset className={styles.scope}>
                <legend className={styles.optionsTitle}>검색 대상</legend>
                <Checkbox
                  label="문제"
                  checked={withQuestions}
                  disabled={withQuestions && !withContent}
                  onCheckedChange={(checked) => changeScope(checked === true, withContent)}
                />
                <Checkbox
                  label="내용"
                  checked={withContent}
                  disabled={withContent && !withQuestions}
                  onCheckedChange={(checked) => changeScope(withQuestions, checked === true)}
                />
              </fieldset>
              <div
                role="group"
                aria-labelledby="search-options-questions"
                className={styles.optionGroup}
              >
                <p id="search-options-questions" className={styles.optionsTitle}>
                  문제 필터
                </p>
                <div className={styles.optionRow}>
                  <Select
                    label="챕터"
                    options={chapterOptions}
                    value={view.chapter ?? ALL}
                    onValueChange={(value) =>
                      value && changeFilters({ chapter: value === ALL ? null : value })
                    }
                  />
                  <Select
                    label="유형"
                    options={[
                      { value: ALL, label: '전체 유형' },
                      ...TYPES.map((type) => ({ value: type, label: questionTypeLabels[type] })),
                    ]}
                    value={view.type ?? ALL}
                    onValueChange={(value) =>
                      value &&
                      changeFilters({ type: value === ALL ? null : (value as QuestionType) })
                    }
                  />
                </div>
              </div>
              <div
                role="group"
                aria-labelledby="search-options-content"
                className={styles.optionGroup}
              >
                <p id="search-options-content" className={styles.optionsTitle}>
                  내용 검색
                </p>
                <ContentSearchOptions
                  search={content}
                  documents={searchDocuments}
                  documentsLoadFailed={library.listFailed}
                />
              </div>
            </PopoverContent>
          </Popover>
        </form>

        <div className={styles.actions}>
          <Button onClick={() => setPanel('documents', true)}>
            문서 <span className={styles.count}>{bookCount}</span>
          </Button>
          <Button asChild>
            <Link href={`/workspaces/${workspace.id}/questions/bank`}>문제은행</Link>
          </Button>
          <IconButton
            label="이력"
            icon={<HistoryIcon />}
            variant="secondary"
            onClick={() => setPanel('history', true)}
          />
          {isOwner ? (
            <Button variant="primary" onClick={() => setPanel('share', true)}>
              공유하기
            </Button>
          ) : null}
        </div>
      </div>

      {withContent ? (
        <ContentSearchResults
          workspaceId={workspace.id}
          search={content}
          onClose={closeContentResults}
        />
      ) : null}

      <QuestionsOverview
        workspaceId={workspace.id}
        readOnly={readOnly}
        filters={filters}
        view={view}
        navigating={navigating}
        onFiltersChange={changeFilters}
        onResetFilters={resetAll}
        overview={overview}
        failure={failure}
        requested={requested}
        panelScreenId={screenIds.practice}
        actions={
          <>
            <Button size="sm" onClick={() => setPanel('question-pdfs', true)}>
              문제 PDF 관리
            </Button>
            {canEdit ? (
              <Button size="sm" variant="primary" onClick={() => setPanel('generate', true)}>
                문제 생성
              </Button>
            ) : null}
          </>
        }
      />

      {/* Dialogs are portalled here so they stay inside the main landmark. */}
      <div ref={setHost} />
      {host ? (
        <>
          <FloatingSidePanel
            open={isOpen('documents')}
            onOpenChange={(open) => setPanel('documents', open)}
            raiseKey={raised.documents}
            modal={false}
            container={host}
            title="문서 관리"
            closeLabel="문서 관리 닫기"
            mobileLayout="full"
          >
            <div data-screen-id={screenIds.documents}>
              <DocumentsLibrary
                workspaceId={workspace.id}
                library={library}
                canEdit={canEdit}
                readOnlyReason={
                  workspace.role === 'viewer' && !workspace.archived
                    ? '뷰어 권한으로는 문서를 볼 수만 있습니다.'
                    : undefined
                }
              />
            </div>
          </FloatingSidePanel>
          <FloatingSidePanel
            open={isOpen('question-pdfs')}
            onOpenChange={(open) => setPanel('question-pdfs', open)}
            raiseKey={raised['question-pdfs']}
            modal={false}
            container={host}
            title="문제 PDF 관리"
            closeLabel="문제 PDF 관리 닫기"
            mobileLayout="full"
          >
            <QuestionPdfsLibrary workspaceId={workspace.id} library={library} canEdit={canEdit} />
          </FloatingSidePanel>
          {canEdit ? (
            <FloatingSidePanel
              open={isOpen('generate')}
              onOpenChange={(open) => setPanel('generate', open)}
              raiseKey={raised.generate}
              modal={false}
              container={host}
              title="문제 생성"
              closeLabel="문제 생성 닫기"
              mobileLayout="full"
            >
              <GenerationDialog
                workspaceId={workspace.id}
                archived={workspace.archived}
                onShuffle={(questionId) => {
                  const search = patchSearch(withPanel(window.location.search, 'generate', false), {
                    question: questionId,
                  });
                  window.history.pushState(null, '', `${pathname}${search}`);
                }}
              />
            </FloatingSidePanel>
          ) : null}
          <FloatingSidePanel
            open={isOpen('history')}
            onOpenChange={(open) => setPanel('history', open)}
            raiseKey={raised.history}
            modal={false}
            container={host}
            title="이력"
            closeLabel="이력 닫기"
            mobileLayout="full"
          >
            <div data-screen-id={screenIds.history}>
              <HistoryPanel workspaceId={workspace.id} viewerId={viewerId} />
            </div>
          </FloatingSidePanel>
          {isOwner && isOpen('share') ? (
            <WorkspaceSharingPanel
              workspaceId={workspace.id}
              archived={workspace.archived}
              open
              onOpenChange={(open) => setPanel('share', open)}
              raiseKey={raised.share}
              container={host}
              screenId={screenIds.share}
            />
          ) : null}
        </>
      ) : null}

      <p role="status" className="qz-visually-hidden">
        {library.announcement}
      </p>
      <ConfirmDialog
        open={library.pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) library.cancelDelete();
        }}
        title="문서를 삭제할까요?"
        description={
          library.pendingDelete
            ? `‘${library.pendingDelete.title}’ 문서가 목록과 검색에서 사라집니다. 이 작업은 되돌릴 수 없습니다.`
            : ''
        }
        confirmLabel="삭제"
        loading={library.deleting}
        onConfirm={() => void library.confirmDelete()}
      />
    </div>
  );
}
